# What ENA's `sequencetools` reveals about ENA's internal submission architecture

**Date:** 2026-09-16
**Audience:** Pathoplexus / Loculus team
**Subject:** the ERAPRO pipeline, the ENAPRO archive, and the one library that runs on both sides of the ENA submission boundary

---

## 0. Scope, sources, and how to read the confidence markers

Everything below is static reading of published source and published jars. Nothing was run, no ENA
service was contacted, no credential was used.

Sources:

| What | Where | Version |
| --- | --- | --- |
| `sequencetools` source | `/workspaces/claude-devcontainer/scratch/sequencetools-src` | git `d731cbc`, shallow depth-1 clone of `https://github.com/enasequence/sequencetools.git` |
| `webin-cli` source | `/workspaces/claude-devcontainer/scratch/webincli-src-2026-07-25/webin-cli` | `build.gradle` says `version = '9.0.3'` |
| shipped webin-cli fat jar | `/home/vscode/.claude/jobs/96bed7ed/tmp/enaval/` (`wcli.jar`, exploded under `fat/`) | `Implementation-Version: 9.0.3`, `Built-By: mhaseeb`, `Built-Date: Wed Feb 11 13:38:06 GMT 2026` |
| the library inside that jar | `fat/BOOT-INF/lib/sequencetools-2.33.2.jar` | 2.33.2 |

Unless a path is qualified, `file:line` citations are relative to the `sequencetools-src` checkout.
Paths beginning `webin-cli/` are relative to the webin-cli checkout.

Confidence markers used throughout, deliberately and consistently:

- **[PROVEN]** — the cited code says exactly this. You can check it in one read.
- **[IMPLIED]** — the code only makes sense if this is true, but the thing itself is outside the repo.
- **[INFERRED]** — my reading. Plausible, not established. Treat as a hypothesis.
- **[GAP]** — we cannot tell from this repo, and I am not going to guess.

**A note on the clone.** The local checkout is `depth=1`, so git history is unavailable locally;
the "commit messages are often more candid than the docs" angle could only be pursued for the
comments that survive in the working tree (there are several, and they are good — see §5.1). A
concurrent web check of the upstream repo's history is summarised in §6.4 where it lands.

**Cross-reference.** A parallel investigation covers *how webin-cli constructs the record it
submits* (source-feature rebuilding, what survives the flatfile round trip) in
`investigations/2026-09-16-ena-webin-cli-record-construction.md`. This document deliberately stops
at the architectural boundary and points there rather than repeating it.

---

## 1. Architecture sketch

Read this first; the rest is evidence.

ENA runs **two Oracle databases** and **one validation library**.

```
                        SUBMITTER'S LAPTOP                    |                 INSIDE EBI
                                                              |
  manifest + FASTA/flatfile/AGP/chromosome_list               |
              |                                               |
              v                                               |
   webin-cli 9.0.3  ──────────────┐                           |
     (WebinCliExecutor)           │ REST (www.ebi.ac.uk)      |
              |                   ├─> study/sample lookup     |      ┌──────────────────────┐
              |                   ├─> ignore_errors           |      │  Webin REST services │
              |                   ├─> rate limit              | <──> │  (drop-box, webin-v2)│
              |                   └─> taxonomy (public)       |      └──────────┬───────────┘
              v                                               |                 │
   sequencetools 2.33.2                                       |                 │ SQL
     SubmissionValidator                                      |                 v
       options.isWebinCLI = true                              |      ┌──────────────────────┐
       eraproConnection = empty                               |      │  ERAPRO  (Oracle)    │
       enproConnection  = empty                               |      │  analysis, sample,   │
              |                                               |      │  study, project,     │
              v                                               |      │  submission_account, │
   local validation + local "fixed" files                     |      │  locus_tag, ...      │
   (the fixed files are then DISCARDED)                       |      └──────────┬───────────┘
              |                                               |                 │
              | uploads the ORIGINAL files + ANALYSIS XML     |                 │
              +---------------------- FTP/Aspera + REST ----> |                 │
                                                              |                 v
                                                              |      ┌──────────────────────┐
                                                              |      │  ENA submission      │
                                                              |      │  pipeline            │
                                                              |      │   sequencetools AGAIN│
                                                              |      │   isWebinCLI = false │
                                                              |      │   + ERAPRO conn      │
                                                              |      │   + ENAPRO conn      │
                                                              |      └──────────┬───────────┘
                                                              |                 │ master.dat,
                                                              |                 │ contigs.reduced.tmp,
                                                              |                 │ scaffolds.reduced.tmp,
                                                              |                 │ chromosome.flatfile.tmp,
                                                              |                 │ unplaced.txt, sequence.info
                                                              |                 v
                                                              |      ┌──────────────────────┐
                                                              |      │  putff (loader)      │
                                                              |      │  + accessioning      │
                                                              |      └──────────┬───────────┘
                                                              |                 v
                                                              |      ┌──────────────────────┐
                                                              |      │  ENAPRO  (Oracle)    │
                                                              |      │  dbentry, bioseq,    │
                                                              |      │  keywords, cv_*,     │
                                                              |      │  mv_project,         │
                                                              |      │  gcs_chromosome,     │
                                                              |      │  prefix_pkg          │
                                                              |      └──────────────────────┘
```

Four things make this picture work, and each is independently checkable:

1. **One library, two modes, one boolean.** `SubmissionOptions.isWebinCLI`
   (`src/main/java/uk/ac/ebi/embl/api/validation/submission/SubmissionOptions.java:59`) is the
   master switch. It is copied into the validation plan as
   `property.isRemote.set(isWebinCLI)` (same file, line 157), and a comment in
   `FileValidationCheck.java:987` states the identity outright: `// isRemote == isWebinCLI`.
   "Remote" here means *remote from EBI* — i.e. running on the submitter's machine. **[PROVEN]**

2. **The DB-backed checks degrade to no-ops rather than failing.** `ValidationPlan.execute()`
   (`ValidationPlan.java:89-106`) constructs the two DAOs only if the corresponding JDBC
   `Connection` is present, then injects them into every check — possibly as `null`. Every
   DB-backed check then begins with a null guard, e.g. `AssemblyInfoSamplewithDifferentProjectCheck.java:33`
   (`if (getEraproDAOUtils() == null) return result;`). So on a laptop the check runs, finds no
   DAO, and silently passes. **[PROVEN]**

3. **Everything that does *not* need the database is a data file in the jar.** The whole INSDC
   feature-table rulebook — permitted qualifiers per feature, mol_type compatibility, taxonomic
   division constraints, dataclass/keyword mapping — is 47 TSVs under
   `src/main/resources/uk/ac/ebi/embl/api/validation/data/`, of which 38 are registered in
   `GlobalDataSetFile.java:13-53` and loaded from the classpath in a static initialiser
   (`GlobalDataSets.java:33-38`). That is *why* webin-cli can validate so much locally: the rules
   travel with the code. **[PROVEN]**

4. **The client's output is thrown away.** webin-cli uploads `manifest.files().get()` — the
   submitter's *original* files (`webin-cli/src/main/java/uk/ac/ebi/ena/webin/cli/WebinCliExecutor.java:262-271`),
   not the `.fixed` files sequencetools just wrote. The whole validation is then re-run inside EBI,
   this time with both databases attached. The local run is a **dry run**, not a preprocessing step.
   **[PROVEN]**

The single most compressed proof of the whole thesis: unzip the webin-cli you downloaded from ENA
and you will find ENA's production Oracle SQL in it. `sequencetools-2.33.2.jar` inside the fat jar
contains `EraproDAOUtilsImpl.class` whose constant pool holds, verbatim,
`select upper(locus_tag) from locus_tag where project_id =?` and
`select 1 from webin_cli_ignore_errors where submission_account_id =? and context =? and name =?`.
Every submitter has a copy of ENA's internal data-access layer; it is simply never wired to a
connection. **[PROVEN]**

---

## 2. What ERAPRO is (and its sibling, ENAPRO)

The brief's lead was that `sequencetools` contains an ERAPRO data-access layer. It does — and it
contains a *second*, quite separate one that is at least as informative.

`src/main/java/uk/ac/ebi/embl/api/validation/dao/` holds exactly four production classes:

```
EntryDAOUtils.java       EntryDAOUtilsImpl.java        -> "enpro" connection  (ENAPRO)
EraproDAOUtils.java      EraproDAOUtilsImpl.java       -> "erapro" connection (ERAPRO)
```

and `SubmissionOptions.java:133-137` names them together in an error message, which is the only
place in the repo where either acronym is spelled out:

> `"SubmissionOptions:Database connections(ENAPRO,ERAPRO) must be given when validating submission internally"`

Note the word **internally**. That message fires only when `isWebinCLI == false`. **[PROVEN]**

### 2.1 The two databases are different systems with different naming cultures

| | **ERAPRO** | **ENAPRO** |
| --- | --- | --- |
| Accessed via | `EraproDAOUtils` | `EntryDAOUtils` |
| `SubmissionOptions` field | `eraproConnection` (`:36`) | `enproConnection` (`:35`) |
| Tables seen | `analysis`, `analysis_sample`, `sample`, `study`, `project`, `submission`, `submission_account`, `submission_contact`, `locus_tag`, `webin_cli_ignore_errors` | `dbentry`, `bioseq`, `keywords`, `cv_ec_numbers`, `cv_database_prefix`, `mv_project`, `gcs_chromosome` |
| Identifier style | `analysis_id` (ERZ…), `submission_id` (ERA…), `study_id`, `sample_id`, `biosample_id`, `submission_account_id` | `primaryacc#`, `dbentryid`, `sequence_acc`, `seq_accid`, `seqlen`, `dataclass` |
| Feel | SRA-style submission metadata, XML-centric | EMBL-Bank-style sequence archive, flatfile-centric |
| What it holds | *what was submitted, by whom, about what* | *what has been archived, with what accession* |

**[PROVEN]** for the table and column names; **[INFERRED]** for the characterisation in the last two rows.

This split matters: ENA's "submission database" and ENA's "sequence archive" are not the same
store, and the pipeline joins across both. A submission is an ERAPRO row long before it is an
ENAPRO entry.

### 2.2 ERAPRO's schema, as implied by the SQL

Every statement is a `PreparedStatement` in `EraproDAOUtilsImpl.java`. Reading them together gives
a usable ER sketch. **[PROVEN]** that these tables/columns exist and join this way; **[GAP]** on
everything not touched by these ten queries.

**`analysis`** — the central table. Columns seen:
`analysis_id` (PK), `submission_id`, `submission_account_id`, `bioproject_id`, `first_created`,
`template_id`, `unique_alias`, `analysis_type`, `status_id`, `analysis_xml`.

- `analysis_id` is the **ERZ accession**: `AssemblyInfoAnalysisIdCheck.java:39` rejects anything not
  matching `^ERZ.*`.
- `submission_id` is the **ERA accession**: `AssemblyInfoSubmissionIdCheck.java:39`, `^ERA.*`.
- `analysis_xml` is an **Oracle XMLType column** holding the submitted ANALYSIS XML. It is queried
  with Oracle's `XMLQuery`/`XMLSERIALIZE` (`EraproDAOUtilsImpl.java:167-177`, `484-509`) and
  `XMLTABLE` with `varchar2(4000) PATH` columns (`:614-626`).
- `analysis_type` is a string; `'SEQUENCE_ASSEMBLY'` is used as a literal at `:291`.
- `status_id` is a submission-lifecycle code; `:292` filters `status_id in (2, 4, 7, 8)`. The
  meanings of those four codes are **[GAP]** — the code does not say. That they are the "counts as
  a real prior submission" set is **[INFERRED]** from the query's purpose (finding conflicting
  earlier assemblies).
- `first_created` is a `DATE`; `:370` does `analysis.first_created-7 begindate, analysis.first_created+7 enddate`,
  i.e. Oracle date arithmetic producing a ±7-day window around the submission. That window is
  carried in `EraproDAOUtils.AssemblySubmissionInfo.begindate/enddate` (`EraproDAOUtils.java:60-61`,
  typed `java.sql.Date`). What consumes it is **[GAP]** — nothing in this repo reads those two
  fields. **[INFERRED]** it feeds a "was there a comparable submission around the same time" rule
  in code we cannot see.

**`analysis_sample`** — a join table, `(analysis_id, sample_id)`. A single analysis can carry
multiple samples (`:505-506`, and the `while (masterInfoRs.next())` loop at `:533` with
`prevSampleId`/`prevProjectId` de-duplication). **[PROVEN]**

**`sample`** — keyed by `sample_id`, carries `biosample_id` (`:485`, `:369-376`). So ERAPRO's own
sample id is distinct from the BioSample accession, and both are stored. **[PROVEN]**

**`study`** — keyed by `study_id`, joined to `sample` in `getAssemblySubmissionInfo` (`:375`).

**`project`** — keyed by `project_id`, and carries `ncbi_project_id`:
`select 1 from project where project_id=? or ncbi_project_id=?` (`:405`). ERAPRO records the NCBI
BioProject identifier alongside ENA's own. **[PROVEN]**. `EntryDAOUtilsImpl.java:172` does the same
against ENAPRO's `mv_project`. The `mv_` prefix is Oracle convention for a **materialized view** —
**[INFERRED]** ENAPRO carries a materialized projection of project data that originates elsewhere
(plausibly from ERAPRO or from the BioProject system).

**`submission`** — keyed by `submission_id`, joined to `analysis` at `:507`.

**`submission_account`** — the Webin account. Columns: `submission_account_id`, `broker_name`,
`center_name`, `laboratory_name`, `address`, `country` (`:215-217`). `broker_name` is the field that
distinguishes brokered submissions — directly relevant to Pathoplexus, which brokers. **[PROVEN]**

**`submission_contact`** — `(submission_account_id, consortium, surname, middle_initials, first_name)`
(`:253`). This is where the RL/citation author list comes from when the submitter did not supply one.
**[PROVEN]**

**`locus_tag`** — `(project_id, locus_tag)` (`:349`). A registry of locus-tag prefixes per project.
**[PROVEN]**

**`webin_cli_ignore_errors`** — `(submission_account_id, context, name)` (`:428`). A per-account,
per-context, per-submission-name allowlist that suppresses validation errors. This is ENA's
"we have agreed to let this one through" table. **[PROVEN]**

**Two more ERAPRO tables, from a different leak.** ENA's public documentation source contains an
reStructuredText *comment* — invisible on the rendered site — carrying the query used to regenerate
the analysis-type/file-format table on
https://ena-docs.readthedocs.io/en/latest/submit/analyses.html
(`scratch/ena-docs-reference/read_docs/submit/analyses.rst:93-98`, verified first-hand in the local
mirror of `enasequence/read_docs`):

```
..  Raw version of above in ERAPRO:
..  select afg.analysis_type, fgf.file_group_id, fgf.file_format, concat(concat(fgf.min_file_cnt, '-'), fgf.max_file_cnt)
..    from cv_file_group_format fgf
..    join cv_analysis_file_group afg on fgf.file_group_id = afg.file_group_id
..   order by afg.analysis_type;
```

So ERAPRO also holds **`cv_analysis_file_group`** `(analysis_type, file_group_id)` and
**`cv_file_group_format`** `(file_group_id, file_format, min_file_cnt, max_file_cnt)` — a controlled
vocabulary defining, per analysis type, which file formats are permitted and in what multiplicity.
**[PROVEN]**. That is the authoritative source of the manifest file-type rules webin-cli enforces
locally, and it confirms ERAPRO carries `cv_` controlled-vocabulary tables of its own, not just
ENAPRO.

### 2.3 ENAPRO's schema, as implied by the SQL

From `EntryDAOUtilsImpl.java`:

- **`dbentry`** — `primaryacc#`, `dbentryid`, `entry_name`, `dataclass` (`:231-232`). The `#` in a
  column name is an old Oracle/EMBL-Bank idiom (compare Oracle's own `con#`, `obj#` dictionary
  columns). This is the flat-file entry table. **[PROVEN]**
- **`keywords`** — `(dbentryid, keyword)`, outer-joined to `dbentry` (`:232`). **[PROVEN]**
- **`bioseq`** — `sequence_acc`, `seq_accid`, `seqlen` (`:132`, `:150`). Existence and length lookups
  for accessions referenced from CON entries and remote feature locations. **[PROVEN]**
- **`cv_ec_numbers`** — `(ec_number, valid)` (`:210`). A controlled vocabulary of EC numbers with a
  validity flag. **[PROVEN]**
- **`cv_database_prefix`** — `(prefix, dbcode)` (`:255`). The registry of accession prefixes.
  `PrimaryAccessionCheck.java:23` names it in a user-visible message: *"Accession prefix is not
  registered in cv/prefix tables"*. **[PROVEN]**
- **`mv_project`** — `project_id`, `ncbi_project_id`, `locus_tag` (`:172`, `:191`). **[PROVEN]**
- **`gcs_chromosome`** — `(assembly_id, object_name, chromosome_name, chromosome_location, chromosome_type)`
  (`:48-49`, `:275`). Note `assembly_id` is bound with the **ERZ analysis id** (`:65`). "GCS" is
  **[INFERRED]** to stand for ENA's Genome Collections service, the component that manages assemblies
  and GCA accessions — consistent with `AssemblyInfoEntry extends GCSEntry` and `GCSEntry`'s sole
  field being `analysisId` (`GCSEntry.java:15-25`).
- **`prefix_pkg`** — a **PL/SQL package**: `select prefix_pkg.get_new_protein_id from dual`
  (`:288`). Oracle's `dual` and a packaged function. This is ENA's accession minting mechanism, or
  at least the protein-id part of it. **[PROVEN]** that it exists and is called this way.

### 2.4 The platform: Oracle, beyond reasonable doubt

Four independent signals, any one of which would be suggestive; together they settle it. **[PROVEN]**

1. `XMLSERIALIZE(CONTENT XMLQuery(... PASSING analysis_xml RETURNING CONTENT))` —
   `EraproDAOUtilsImpl.java:169-176`. Oracle SQL/XML syntax.
2. `XMLTABLE(... COLUMNS name varchar2(4000) PATH 'NAME', ...)` — `:620-625`. `varchar2` is Oracle's
   spelling.
3. `select prefix_pkg.get_new_protein_id from dual` — `EntryDAOUtilsImpl.java:288`. `dual` is Oracle.
4. `dbentry.primaryacc#` — `EntryDAOUtilsImpl.java:232`. `#` is legal in Oracle identifiers.

And the build declares the driver: `testRuntimeOnly 'com.oracle.database.jdbc:ojdbc8:19.8.0.0'`
(`build.gradle`, dependencies block).

### 2.6 The identifier grammar ERAPRO enforces

Collected from the `@RemoteExclude` checks and `AccessionMatcher`. **[PROVEN]**

| Thing | Pattern | Where |
| --- | --- | --- |
| Analysis (an assembly submission) | `^ERZ.*` | `AssemblyInfoAnalysisIdCheck.java:39` |
| Submission | `^ERA.*` | `AssemblyInfoSubmissionIdCheck.java:39` |
| Project / BioProject | `^PRJ[END][A-Z]\d+$` | `AssemblyInfoProjectIdCheck.java:28` |
| Assembly master accession | `^(ERZ\|GCA_)[0-9]+$` | `AccessionMatcher.java:50-51` |
| Standard sequence accession (old) | `^([A-Z]{1,2})([0-9]{5,6})$` | `AccessionMatcher.java:28-29` |
| Standard sequence accession (new) | `^([A-Z]{2})([0-9]{8})$` | `AccessionMatcher.java:30-31` |
| WGS sequence (old / new) | `^([A-Z]{4})([0-9]{2})(S?)([0-9]{6,8})$` / `^([A-Z]{6})([0-9]{2})(S?)([0-9]{7,9})$` | `AccessionMatcher.java:34-37` |
| WGS **master** (all-zero suffix) | `^([A-Z]{4})[0-9]{2}[0]{6,8}$` / `^([A-Z]{6})[0-9]{2}[0]{7,9}$` | `AccessionMatcher.java:38-41` |
| Scaffold within a WGS set | the `S` infix variants | `AccessionMatcher.java:43-46` |
| `protein_id` | `^\s*([A-Z]{3}\d{5}(\d{2})?)(\.)(\d+)\s*$` | `AccessionMatcher.java:48-49` |
| TPX | `^TPX_[0-9]{6}$` | `AccessionMatcher.java:52` |

The all-zero-suffix WGS master pattern is the mechanically interesting one: a WGS set's master
record is the member whose numeric part is all zeros. `DataclassProvider.getAccessionDataclass`
(`DataclassProvider.java:27-39`) uses exactly that, plus the ERZ/GCA_ pattern, to decide that an
accession belongs to a `SET`-dataclass entry.

---

## 3. The seam: exactly where client mode and server mode diverge

The brief's hypothesis — one library, two modes, DB dependency absent client-side, master entry
built from the manifest instead — is **confirmed**, and can be refined in three ways:

- the seam is not one boundary but **three** (JDBC connections, a service registry, and REST clients);
- the flag has two names for the same thing (`isWebinCLI` and `isRemote`), with a comment saying so;
- a handful of checks do not merely switch off client-side, they behave **differently** — which is
  more dangerous than switching off (§4.7).

### 3.1 The entry points

| Mode | Entry class | Sets |
| --- | --- | --- |
| **Client** (webin-cli) | `SubmissionValidator.validate(Manifest)` → `mapManifestToSubmissionOptions` (`SubmissionValidator.java:92-242`) | `options.isWebinCLI = true` (`:155`); `FeatureReader.isWebinCli = true` (`:98`); never sets `eraproConnection`/`enproConnection` |
| **Server** (pipeline) | `SubmissionValidator.validate()` (`SubmissionValidator.java:51-84`) with an externally built `SubmissionOptions` | `isWebinCLI` left `false` (default, `SubmissionOptions.java:59`); both connections populated |

webin-cli reaches the library through exactly one class: `WebinCliContext`
(`webin-cli/src/main/java/uk/ac/ebi/ena/webin/cli/WebinCliContext.java:36-59`) names
`uk.ac.ebi.embl.api.validation.submission.SubmissionValidator` as the `Validator` for the `genome`,
`transcriptome`, `sequence` and `polysample` contexts. That is the entire public surface webin-cli
uses. **[PROVEN]** — and it confirms the brief's grep result: webin-cli contains zero references to
`EraproDAOUtils`, because it never needs to; it stops at `SubmissionValidator`.

The server-side caller is **not in either repo**. `SubmissionValidator.validate()` (the no-arg
overload, `:51`) exists solely for it, and `SubmissionOptions.init()` (`:84-144`) is written to
police that caller's contract. **[IMPLIED]** ENA has an internal application that constructs
`SubmissionOptions` directly, opens two Oracle connections, and calls `validate()`.

### 3.2 Branch points, with file:line

This is the complete set of places in `sequencetools` `src/main` where the mode is consulted.

| # | Location | What changes |
| --- | --- | --- |
| 1 | `SubmissionOptions.java:91-92` | server mode does not require `assemblyInfoEntry` |
| 2 | `SubmissionOptions.java:93-103` | server mode does not require a `source` feature |
| 3 | `SubmissionOptions.java:106-116` | client must give a per-file report file; server needs `reportDir` to be a real directory |
| 4 | `SubmissionOptions.java:117-118` | **server must supply `analysisId`**; client must not |
| 5 | `SubmissionOptions.java:119-123` | server must supply `processDir` for genome/transcriptome (to write `master.dat`) |
| 6 | `SubmissionOptions.java:133-138` | **server must supply both JDBC connections** |
| 7 | `SubmissionOptions.java:140-143` | server needs a `ServiceConfig` (ERA service URL/user/password) for `Context.sequence` |
| 8 | `SubmissionOptions.java:157` | `property.isRemote.set(isWebinCLI)` — the alias |
| 9 | `ValidationPlan.java:89-92` | `EntryDAOUtils` built only if `enproConnection != null` |
| 10 | `ValidationPlan.java:93-104` | `EraproDAOUtils` built only if `eraproConnection != null` |
| 11 | `ValidationPlan.java:113,116-118` | `@RemoteExclude`-annotated checks are skipped entirely when `remote` |
| 12 | `MasterEntryService.java:49-63` | **the master-entry fork**: manifest vs ERAPRO |
| 13 | `MasterEntryValidationCheck.java:57-65` | `master.dat` is written only in server mode |
| 14 | `SubmissionValidationPlan.java:132-135` | `unplaced.txt` is written only in server mode (and only for distributed assembly types) |
| 15 | `SubmissionValidationPlan.java:151-158` | `VALIDATION_STATS.log` is written only in server mode |
| 16 | `SubmissionValidationPlan.java:190-192, 212-215, 234, 258, 279, 301-303, 347-349, 373` | client mode **throws** on first invalid file; server mode returns the `ValidationResult` and carries on |
| 17 | `SubmissionValidationPlan.java:411-421` | client wraps exceptions as `VALIDATION_ERROR`; server rethrows raw |
| 18 | `SubmissionValidator.java:64-83` | server aggregates up to 2000 chars of errors (incl. *curator* and *report* messages) into one exception; client writes per-file reports instead |
| 19 | `FileValidationCheck.java:634-653` | server builds the submitter reference from ERAPRO; client substitutes a hard-coded placeholder (§3.5) |
| 20 | `FileValidationCheck.java:755-759` | client does **not** write the reduced flatfiles at all |
| 21 | `FileValidationCheck.java:468-471` | client does not flush/close the reduced-file writers |
| 22 | `FileValidationCheck.java:987-990` | **`assignProteinAccession` returns immediately when remote** |
| 23 | `SubmitterAccessionCheck.java:47-57` | client errors on a >50-char entry name; server silently truncates (§4.7) |
| 24 | `FeatureReader.java:181-184` | client **rejects** any feature with a remote location (`error("FT.16")`); server accepts it |

Plus one in webin-cli's copy of the flag on the other side of the API:
`webin-cli/.../WebinCliExecutor.java:118,120` calls `setIgnoreErrors` and
`checkGenomeSubmissionRatelimit` *before* validating — two REST round trips that stand in for
ERAPRO reads (§4.6).

### 3.3 The three injection mechanisms

The seam is not a single abstraction. There are three, layered:

**(a) JDBC connections in `SubmissionOptions`.** `Optional<Connection> enproConnection` /
`eraproConnection` (`SubmissionOptions.java:35-36`), copied into
`EmblEntryValidationPlanProperty.enproConnection/eraproConnection` (`:24-27`), and turned into DAOs
lazily in `ValidationPlan.execute` (`:89-104`). Note `EntryDAOUtilsImpl` is a process-wide
singleton (`EntryDAOUtilsImpl.java:33-38`, `getEntryDAOUtilsImpl` caches a static) while
`EraproDAOUtilsImpl` is per-plan and carries its own two caches
(`assemblySubmissionInfocache`, `masterCache`, `EraproDAOUtilsImpl.java:49-51`). **[PROVEN]**

**(b) `SequenceToolsServices`, a one-shot static registry.** `SequenceToolsServices.java:15-42`
holds three `AtomicReference`s and `init(...)` uses `compareAndSet(null, …)` — first writer wins
for the process lifetime. Two of the three are interfaces with **no implementation in this repo**:

- `SampleRetrievalService` (`SampleRetrievalService.java:16-18`) — webin-cli-mode does inject one,
  `WebinSampleRetrievalService`, but only for `Context.sequence` (`SubmissionValidator.java:53-61`).
- `SequenceRetrievalService` (`SequenceRetrievalService.java:19-32`), documented as *"Retrieves
  sequences from the cram reference registry"*. **Nothing in either repo implements it.** Its sole
  consumer is `SegmentFactory` (`SegmentFactory.java:31-33`), which degrades gracefully:
  `if (compoundLocation.hasRemoteLocation() && service == null) return null;` (`:61-63`).
  **[IMPLIED]** ENA's pipeline injects a CRAM-reference-registry-backed implementation here.
  **[PROVEN]** webin-cli never does.

**(c) REST clients.** `SubmissionOptions` carries `webinRestUri`, `webinAuthUri`, `webinAuthToken`,
`webinUsername/Password`, `biosamplesUri`, `biosamplesWebin*` (`:40-51`) plus a `ServiceConfig`
holding `eraServiceUrl/User/Password` (`ServiceConfig.java:13-41`). Both modes use REST — but with
**different auth**: webin-cli passes a bearer token (`SubmissionValidator.java:228-231`,
`WebinSampleRetrievalService.java:44-49`), the pipeline passes a username/password pair
(`EraproDAOUtilsImpl.java:104-133`, which *throws* if either is blank). **[PROVEN]**

The `ServiceConfig.eraServiceUrl` is interesting: a **third** way to reach ERAPRO, over HTTP rather
than JDBC, required only for `Context.sequence` in server mode (`SubmissionOptions.java:140-143`,
`:177-187`). Nothing in this repo calls it. **[GAP]** — but it suggests ENA is migrating at least
the sequence context off direct JDBC onto a service.

### 3.4 The annotation system: three orthogonal switches

`ValidationPlan.execute` (`:111-141`) reads three class-level annotations before running a check:

- **`@RemoteExclude`** (`annotation/RemoteExclude.java`, javadoc: *"disable the check for remote
  applications/executions"*) — skip when `isRemote`. Used on exactly **four** classes, all in
  `check/genomeassembly/`: `AssemblyInfoAnalysisIdCheck`, `AssemblyInfoProjectIdCheck`,
  `AssemblyInfoSubmissionIdCheck`, `AssemblyInfoSamplewithDifferentProjectCheck`. **[PROVEN]**
  These validate the *ERAPRO row*, not the submitter's files, so they are meaningless on a laptop.
- **`@ExcludeScope`** — skip for listed `ValidationScope`s, optionally demoting severity instead of
  skipping (`ValidationPlan.java:136-141` → `demoteSeverity`). Used on **91** classes; by far the
  commonest exclusion is `{NCBI, NCBI_MASTER}` (46 classes). **[PROVEN]**
- **`@GroupIncludeScope`** — run only within a scope group (`ASSEMBLY` or `SEQUENCE`).

`demoteSeverity` is worth flagging: an excluded-scope check whose `maxSeverity` is not `ERROR` still
runs, and its ERRORs are rewritten down to WARNING/INFO/FIX (`ValidationPlan.java:154-168`). So
"the same check" can be fatal in one scope and advisory in another.

### 3.5 The placeholder that gives the game away

When webin-cli needs a submitter reference for a template/TSV submission and the manifest carries no
`AUTHORS`/`ADDRESS`, `FileValidationCheck.addTemplateHeader` fabricates one
(`FileValidationCheck.java:654-668`):

```java
Person person = referenceFactory.createPerson("CLELAND");
...
submission.setSubmitterAddress(
    ", The European Bioinformatics Institute (EMBL-EBI), Wellcome Genome Campus, CB10 1SD, United Kingdom");
```

In server mode the same method takes the branch above it (`:634-653`) and pulls the real reference
out of ERAPRO via `getReference(...)` falling back to `getSubmitterReference(...)`. **[PROVEN]**

This is the cleanest possible illustration of the seam: the client emits a *dummy* RL line with a
curator's surname and EBI's postal address, purely so the record is structurally complete enough to
validate. The record ENA actually archives has the real one, assembled from
`submission_account` + `submission_contact`. Anything a submitter concludes from the reference block
of a locally-generated `.fixed` file is fiction.

---

## 4. What the client cannot do, and therefore what only runs at EBI

### 4.1 The complete list of DB-gated checks and fixes

Twelve classes in `src/main` consult a DAO. All of them are inert on a laptop. **[PROVEN]** — this
list is exhaustive for `src/main` (`rg -l 'getEntryDAOUtils\(\)|getEraproDAOUtils\(\)'`).

| Class | DB | What it can only know server-side |
| --- | --- | --- |
| `check/entry/LocusTagPrefixCheck.java:48-66` | both | which locus-tag prefixes are registered to the project |
| `check/entry/EntryProjectIdCheck.java:126-132` | both | whether the project accession exists at all |
| `check/entry/EntryContigsCheck.java:71,87,93` | ENAPRO | whether each CON component accession exists and its length |
| `check/entry/FeaturewithRemoteLocationCheck.java:50,80` | ENAPRO | whether a remote feature location points at a real entry of sufficient length |
| `check/entry/MasterEntryExistsCheck.java:44-59` | ENAPRO | whether this assembly's master record is already in the archive |
| `check/entry/PrimaryAccessionCheck.java:48-56` | ENAPRO | whether the accession prefix is registered in `cv_database_prefix` |
| `check/feature/EC_numberCheck.java:34,43` | ENAPRO | whether an EC number is valid/current per `cv_ec_numbers` |
| `check/feature/FeatureLocationCheck.java:76-77` | ENAPRO | same, for feature locations |
| `check/sourcefeature/ChromosomeSourceQualifierCheck.java:68` | ENAPRO | the registered chromosome/plasmid/segment name for this object, from `gcs_chromosome` |
| `check/genomeassembly/AssemblyInfoSamplewithDifferentProjectCheck.java:33-43` | ERAPRO | whether **other, earlier** assemblies reuse this sample under a different study |
| `fixer/entry/AgptoConFix.java:64` | ENAPRO | (passes the DAO through to `AGPValidationCheck`) |
| `fixer/sequence/ContigstosequenceFix.java:45-46` | ENAPRO | expanding a CON entry's contig list into actual bases |

Add to that the four `@RemoteExclude` classes (§3.4) and `assignProteinAccession`
(`FileValidationCheck.java:985-1010`).

### 4.2 Accession minting is a database call, full stop

`EntryDAOUtilsImpl.getNewProteinId()` is `select prefix_pkg.get_new_protein_id from dual`
(`:286-296`). `FileValidationCheck.assignProteinAccession` calls it once per CDS feature and appends
`.1` (`:997-1003`), and is a no-op when remote (`:987-990`). It runs only for scopes
`ASSEMBLY_CONTIG`, `ASSEMBLY_SCAFFOLD`, `EMBL_TEMPLATE`, or `Context.transcriptome`
(`:1012-1019`, carrying the ticket comment `// ENA-6938 assign protein_id to EMBL_TEMPLATE also`).
**[PROVEN]**

Nucleotide accessions are *not* minted here at all. `AssemblySequenceInfo` carries an `accession`
field (`AssemblySequenceInfo.java:34`) that is **constructed as `null` at all three construction
sites** (`FastaFileValidationCheck.java:134`, `FlatfileFileValidationCheck.java:129`,
`AGPFileValidationCheck.java:148`) and **never read anywhere in `src/main`**. It is written into the
serialized `sequence.info` map for a downstream consumer. **[PROVEN]**

`AssemblyInfoEntry` (`AssemblyInfoEntry.java:16-46`) is plainly a projection of an ERAPRO/GCS row
and names the accessioning outputs: `setId`, `wgsId`, `masterId`, `gcId`, and
`contigAccRange` / `scaffoldAccRange` / `chromosomeAccRange`. The repo ships a parser for that range
format — `common/accession/SequenceAccessionRangeSplitter.java:22-26`, comma-separated ranges of
`FIRST-LAST`. **[IMPLIED]** ENA assigns accessions to an assembly as contiguous *ranges per assembly
level*, recorded on the assembly row, rather than one at a time. `AssemblyInfoEntry` also carries a
`distribute` field (`:46`) that is never read in this repo. **[INFERRED]** it is the per-assembly
INSDC-distribution flag.

So: `sequencetools` validates and normalises; it does not accession (except protein ids). The
minting lives in `prefix_pkg` and in whatever writes those range columns. **[GAP]** on that code.

### 4.3 Worked example — locus tag prefixes

`LocusTagPrefixCheck` is the single best illustration of "the same check, three ways":

```java
// LocusTagPrefixCheck.java:48-66
if (getEntryDAOUtils() == null && getEraproDAOUtils() == null) {
  if (...getOptions().locusTagPrefixes.isPresent()) {
    projectLocustagPrefixes.addAll(...getOptions().locusTagPrefixes.get());   // <- webin-cli path
  }
} else {
  for (Text projectAccession : entry.getProjectAccessions()) {
    Set<String> locusTagPrefixes =
        getEraproDAOUtils() == null
            ? getEntryDAOUtils().getProjectLocutagPrefix(...)   // ENAPRO: mv_project
            : getEraproDAOUtils().getLocusTags(...);            // ERAPRO: locus_tag
    ...
  }
}
```

So there are three sources of truth for the same fact, and the client uses the weakest:

1. **ERAPRO** `select upper(locus_tag) from locus_tag where project_id =?` — preferred server-side.
2. **ENAPRO** `select upper(locus_tag) from mv_project where project_id=? or ncbi_project_id=?` —
   the `putff`/loader path.
3. **whatever the client was told over REST.** `SubmissionValidator.java:139-141` populates
   `options.locusTagPrefixes` from `manifest.getStudy().getLocusTags()`, and that list comes from
   `webin-cli/.../service/StudyService.java:47-49,68` — `POST cli/reference/project/{id}` against
   `https://www.ebi.ac.uk/ena/submit/drop-box/`, whose response DTO is
   `{bioProjectId, locusTags, canBeReferenced}`.

**[PROVEN]**. Consequence: webin-cli *does* check locus-tag prefixes, but against a REST snapshot of
the registry taken at validation time, for the one project in the manifest. Note also the BioSample
accession is unconditionally accepted as a locus-tag prefix (`:41-45`) in all three modes — an
undocumented escape hatch.

**[INFERRED]** the practical failure mode: register a prefix and validate in the same minute and the
REST view may not have it yet; or submit a flatfile whose `PR` line names a project other than the
manifest's and the client has no prefixes for it at all, while the server does.

### 4.4 Worked example — project validation

`EntryProjectIdCheck.java:121-136`: if a project accession is present, ask whichever DAO exists
whether it is real. ERAPRO answers from `project`, ENAPRO from `mv_project`, and both accept
`ncbi_project_id` as an alias. With no DAO — webin-cli — the loop body's guards are both false and
**nothing is checked**. The message `EntryProjectIdCheck9` ("Invalid projectId") is therefore an
error a submitter can only ever see after submitting. **[PROVEN]**

Everything *else* in that check (the >100 kb / circular / WGS / CON / "complete genome" keyword
heuristics, the multiple-project rule) is pure in-memory logic and does run locally.

### 4.5 A correction to the brief: taxonomy is **not** server-only

The brief listed taxonomy lookups among the things that only run at EBI. The code says otherwise.

`TaxonomyClient` comes from `uk.ac.ebi.ena.taxonomy:webin-taxonomy-sdk` (declared `api` in
`build.gradle`), and the shipped `webin-taxonomy-sdk-1.2.0.jar` hard-codes a single unauthenticated
endpoint template in `TaxonomyClient$TaxonomyUrl`:

```
https://www.ebi.ac.uk/ena/taxonomy/rest/%s/%s      (paths: scientific-name, tax-id, any-name, common-name, suggest-for-submission)
```

verified by `javap -c` on the class in the fat jar. A `new TaxonomyClient()` is constructed
unconditionally in `ValidationPlan`'s constructor (`:41`) and in `SubmissionOptions.getEntryValidationPlanProperty()`
(`:156`) in **both** modes. **[PROVEN]**

So organism validity, `isChildOf(..., "Viruses")`, metagenome detection and submittability all run
on the client — but they are **network calls to a public ENA service**, not local logic. Two
consequences: a submitter offline gets different behaviour from a submitter online
(`TemplateEntryProcessorTest.java:127` shows the failure mode: *"Error while calling the url: …/tax-id/…"*),
and taxonomy answers can change between a local `-validate` and the server's re-run.

Similarly, **sample metadata is REST, not SQL, on both sides.** `EraproDAOUtilsImpl` does not query
a sample table for source qualifiers; `getSourceFeature(sampleId)` (`:417-421`) calls
`SampleService` (Webin REST + BioSamples) exactly as the client does. The test at
`EraproDAOUtilsImplTest.java:59-63` even documents the fallback: *"This ID represents a sample which
is private and does not contain full information on Biosamples … if sample cannot be retrieved from
Biosamples then it will be retrieved from ENA instead."* **[PROVEN]**

The refined rule is therefore: **the seam is not "network vs. local", it is "submission-registry
state vs. everything else."** Reference data (taxonomy, BioSamples) is reachable from both sides.
Submission-registry state — what *you* have submitted before, what *your* account is allowed to do,
what is registered against *your* project — is ERAPRO/ENAPRO only.

### 4.6 Two pieces of ERAPRO state that ENA deliberately exposes over REST

Because the client *does* need them, ENA mirrors two ERAPRO facts through the Webin REST API:

| ERAPRO query | REST equivalent in webin-cli |
| --- | --- |
| `select 1 from webin_cli_ignore_errors where submission_account_id=? and context=? and name=?` (`EraproDAOUtilsImpl.java:428`) | `POST cli/ignore_errors/` with `{context, name}` (`webin-cli/.../service/IgnoreErrorsService.java:68-70`), called at `WebinCliExecutor.java:172-180` |
| (no equivalent in this repo) | `POST cli/submission/v2/ratelimit/` with `{context, submissionAccountId, studyId, sampleId}` (`webin-cli/.../service/RatelimitService.java:43-63`), called at `WebinCliExecutor.java:186-215` |

**[PROVEN]**. The rate limiter is the purest example of a check that can only be server-side: it
returns `lastSubmittedAnalysisId` and blocks the submission client-side *before* validation runs
(`WebinCliExecutor.java:210-214`, message `CLI_GENOME_RATELIMIT_ERROR_WITH_ANALYSIS_ID`). Note it is
skipped entirely when `ignoreErrors` is set (`:187`) — so the `webin_cli_ignore_errors` row also
disables rate limiting.

`ignoreErrors` inside `sequencetools` is narrower than its name suggests. It gates only:
`validateAssemblySequenceCount` (`Utils.java:932-941`, an unconditional early return),
the 30 000-sequence template cap (`FileValidationCheck.java:744`), intron length
(`IntronLengthWithinCDSCheck.java:54`), scaffold components (`ScaffoldComponentCheck.java:40`),
chromosome names (`ChromosomeListChromosomeNameCheck.java:51`), and the entry-name length rule
(`SubmitterAccessionCheck.java:66`). It is *not* a global mute. **[PROVEN]**

### 4.7 The dangerous category: checks that behave *differently* rather than switching off

These are worse than absent checks, because a clean local run actively misleads.

**`SubmitterAccessionCheck`** (`SubmitterAccessionCheck.java:40-58`) — for an entry name longer than
50 characters:

- client (`isWebinCLI`, and the assembly type is distributed, and errors are not ignored) →
  **hard error** `SubmitterAccessionCheck_2`;
- server (`!isWebinCLI`) → **silently truncates** to 30 chars and appends a 5-character unique
  suffix (`truncateAndAddUniqueString`, `:69-75`, backed by a static `AtomicInteger`), mutating the
  entry.

So the name in the archive may not be the name you submitted, and only the server does this.
**[PROVEN]**

**`FeatureReader`** (`FeatureReader.java:181-184`) — a feature whose location references another
accession (a remote location) is a hard `FT.16` error **only** when `isWebinCli`. Server-side it is
accepted and later resolved against ENAPRO/the CRAM registry. **[PROVEN]** This is a rule that exists
purely because the client cannot resolve it, not because it is invalid.

**`MasterEntryService`** (`MasterEntryService.java:45-63`) — the master entry is built from two
entirely different sources (§5.3). Same class, same downstream validation, different inputs.

**`addTemplateHeader`** — the CLELAND placeholder (§3.5).

---

## 5. What else the codebase leaks about ENA's pipeline

### 5.1 `putff` — the loader, named in comments and in an enum

`ValidationScope` is the single most candid artefact in the repo. Someone annotated every constant
with the internal system it serves (`ValidationScope.java:13-41`):

```java
public enum ValidationScope {
  /** Putff (ENA) */                          EMBL(Group.SEQUENCE),
  /** Putff (NCBI) */                         NCBI(Group.SEQUENCE),
  /** Putff (NCBI master) */                  NCBI_MASTER(Group.SEQUENCE),
  /** Pipeline (Webin-CLI sequence scope) */  EMBL_TEMPLATE(Group.SEQUENCE),
  /** Putff (patent protein) */               EPO_PEPTIDE(Group.SEQUENCE),
  /** Putff (patent) */                       EPO(Group.SEQUENCE),
  /** TODO: remove if not used */             INSDC, EGA, ARRAYEXPRESS,
  /** Pipeline (Webin-CLI genome scope) */    ASSEMBLY_MASTER, ASSEMBLY_CONTIG,
                                              ASSEMBLY_SCAFFOLD, ASSEMBLY_CHROMOSOME,
  /** Pipeline (Webin-CLI transcriptome scope) */ ASSEMBLY_TRANSCRIPTOME;
```

Those javadoc comments were added deliberately — upstream commit `8dadb089`, 2023-10-19,
*"Added ValidationScope enumeration comments."* **[PROVEN]**

`putff` is named three more times in the working tree:

- `EraproDAOUtilsImpl.java:516` — `// sequence.setLength(1); // Required by putff.` sitting above the
  master entry's zero-length `Sequence`. **[IMPLIED]** putff will not accept a master entry with a
  null/zero sequence length, which is why `setIdLineSequenceLength(1)` is set twice (`:468`, `:518`).
- `ValidationUnit.java:70` and `:200` — `// ENA-6041: Removing the fix as created issue in putff.`
  A fixer (`QualifierWithinQualifierFix`) was **disabled in the shared library because it broke the
  loader**. **[PROVEN]**

What this tells us. **[INFERRED, but strongly]** ENA's architecture has (at least) two consumers of
`sequencetools` besides webin-cli:

1. **putff**, the EMBL-Bank flatfile loader that writes into ENAPRO. It has five scopes of its own
   (`EMBL`, `NCBI`, `NCBI_MASTER`, `EPO`, `EPO_PEPTIDE`) — including patent data and,
   crucially, **NCBI and NCBI_MASTER**.
2. **"the pipeline"**, which processes Webin submissions and uses the ASSEMBLY_* / EMBL_TEMPLATE scopes.

The NCBI scopes are the mirroring path. `ValidationScope.getScope(FileType)` (`:84-89`) returns
`NCBI` for `FileType.GENBANK`, and `FileUtils.java:21,123-124` sniffs a GenBank file by its `LOCUS`
first line. The repo contains a full GenBank reader and writer tree
(`src/main/java/uk/ac/ebi/embl/flatfile/{reader,writer}/genbank/`), and 46 checks are excluded for
`{NCBI, NCBI_MASTER}` — i.e. ENA deliberately relaxes about half its own rules for records arriving
from NCBI, and `CollectionDateQualifierFix.java:61-62` even applies an NCBI-specific date format.
`EmblEntryValidationPlanProperty.ncbiCon` (`:38`) is a flag for NCBI CON entries. **[PROVEN]** for
the mechanism; **[INFERRED]** that this is the INSDC ingest path for GenBank records into ENA, but
it is hard to read it any other way.

### 5.2 Dataclasses and divisions

`src/main/resources/uk/ac/ebi/embl/api/validation/data/dataclass.tsv` is the operative list of valid
ID-line dataclasses — **15 entries**:

```
PRT  TPX  PAT  GSS  EST  STS  HTC  CON  WGS  STD  HTG  MGA  TSA  SET  TLS
```

`Entry.java:60-77` declares those plus `TPA_DATACLASS = "TPA"` (which is *not* in the TSV — it is a
keyword-derived intermediate, folded into WGS/CON/TSA by
`DataclassProvider.getKeywordDataclass:77-89`). **[PROVEN]**

How a dataclass gets assigned — `DataclassFix.java:61-130`, in priority order: (1) `CON` is left
alone; (2) the KW line, via `keyword_dataclass.tsv` (22 mappings of compressed keyword → dataclass),
but only if the KW line implies exactly one dataclass; (3) the accession shape, via
`DataclassProvider.getAccessionDataclass` — all-zero WGS master or `ERZ`/`GCA_` → `SET`,
`TPX_nnnnnn` → `TPX`. **[PROVEN]**

Dataclass is also coupled to assembly level — `AssemblyLevelDataclassCheck.java:51-69`:

| Scope | Required dataclass |
| --- | --- |
| `ASSEMBLY_MASTER` | must be `SET` |
| `ASSEMBLY_CONTIG` (level 0) | must be `WGS` |
| `ASSEMBLY_SCAFFOLD` (level 1) | (not constrained here) |
| `ASSEMBLY_CHROMOSOME` (level 2) | must **not** be `WGS` or `SET` |

**Divisions** appear only as three-letter codes in two rule tables:
`taxonomic_division-qualifier.tsv` (`variety` → `PLN,FUN`; `cultivar` → `PLN`; `serovar` → `PRO`)
and `taxonomic_division-no-qualifier.tsv` (`tissue_type`,`dev_stage` forbidden for `PRO`;
`collected_by`,`identified_by`,`lat_lon` forbidden for `HUM`). The division itself is never computed
in this repo — **[GAP]**; something upstream sets it. **[INFERRED]** it is derived from taxonomy at
load time.

### 5.3 The master entry: two constructions of the same object

`MasterEntryService.createMasterEntry(options, result)` (`MasterEntryService.java:45-74`) forks on
`isWebinCLI`, then runs the **same** `EmblEntryValidationPlan` over whichever object it built
(`:70-72`). The two constructions:

| | server — `getMasterEntryFromSubmittedXml` (`:76-100`) → `EraproDAOUtilsImpl.createMasterEntry` (`:457-611`) | client — `getMasterEntryFromWebinCli` (`:122-184`) |
| --- | --- | --- |
| primary accession | `analysisId` (the ERZ) — `:467` | *not set* |
| project accession | `a.bioproject_id` from the `analysis`/`project` join — `:540-543` | `infoEntry.getProjectId()` — `:159` |
| BioSample xref | `sam.biosample_id` — `:546-549` | `infoEntry.getBiosampleId()` — `:160` |
| ENA xrefs (DR lines) | `RUN_REF`/`ANALYSIS_REF` `PRIMARY_ID`s scraped out of `analysis_xml` — `:551-554`, `:644-653` | **none** |
| mol_type | `analysis_xml` `MOL_TYPE`, but only applied when the organism is under `Viruses` — `:562,571-573` | `infoEntry.getMoleculeType()`, unconditionally — `:151-155` |
| TPA keywords | `analysis_xml` `TPA` — `:563-567` | `infoEntry.isTpa()` — `:161-163` |
| comment (CC) | `analysis_xml` `DESCRIPTION`, plus for transcriptomes a generated block from `a.name/platform/program` via `XMLTABLE` — `:575-578`, `:613-642`, `MasterEntryService.java:88-94` | **none** |
| reference (RL) | manifest AUTHORS/ADDRESS if present, else built from `submission_account` + `submission_contact` — `:589-601` | manifest AUTHORS/ADDRESS if present, else **nothing** — `:171-181` |
| source feature | from `sampleService.getSample(sampleId)` (REST) — `:569,603` | from `options.source`, itself built from the manifest's `Sample` — `SubmissionValidator.java:147-153` |
| dataclass / topology | `SET`, LINEAR, length 1 — `:513-524` | `SET`, LINEAR, length 1 — `:144-157` |

**[PROVEN]**. The shapes agree; the provenance does not. Note in particular that a locally generated
master has **no DR (cross-reference) lines and no CC block** — those exist only in the archived
record.

`master.dat` is written to `processDir` only server-side (`MasterEntryValidationCheck.java:57-65`).
**[IMPLIED]** it is then fed to putff. Note also `MasterEntryValidationCheck.java:38-45`: the scope
is forced to `ASSEMBLY_MASTER` unless it is already `NCBI_MASTER` — the master-building code is
shared with the NCBI intake path.

### 5.4 How an assembly relates to its component entries

`FileValidationCheck.getValidationScope(submitterAccession)` (`:135-165`) classifies each entry by
**name**, against state accumulated from the list files:

```
name in chromosome_list          -> ASSEMBLY_CHROMOSOME (level 2)   [and must not also be unlocalised]
name appears as an AGP object    -> ASSEMBLY_SCAFFOLD   (level 1)
otherwise                        -> ASSEMBLY_CONTIG     (level 0)
```

and simultaneously accumulates `sharedInfo.unplacedEntryNames` (`:149-153`). **[PROVEN]**

`unplaced` therefore means: *a sequence in this assembly that is neither a named chromosome nor
listed as unlocalised to one*. Two code paths produce the list — the AGP path above, and
`SubmissionValidationPlan.populateNonAgpUnplacedEntryNames()` (`:441-453`) for assemblies with no
AGP at all. It is serialized with `ObjectOutputStream` to `processDir/unplaced.txt`
(`:455-470`) — despite the `.txt` extension it is a **Java-serialized `Set`**, not text. It is
written **only** when `!isWebinCLI` **and** the assembly type is distributed (`:132-135`).
**[IMPLIED]** a downstream stage deserializes it, and it exists to tell that stage which sequences
have no placement in the assembly's chromosome structure.

`AgptoConFix.java:52-69` is the AGP→CON conversion: validate the AGP rows, call
`EntryUtils.convertAGPtofeatureNContigs(entry)`, then `entry.setDataClass(Entry.CON_DATACLASS)`.
So an AGP row set becomes a `CON` entry whose "sequence" is a contig join. The reverse direction —
materialising a CON entry's bases — is `ContigstosequenceFix`, which requires ENAPRO
(`:45-46`) and the CRAM-registry `SequenceRetrievalService` (`SegmentFactory.java:61-63`), and sets
`entry.setNonExpandedCON(true)` (`:58`). **[PROVEN]**

`AGPFileValidationCheck` builds a **MapDB file database** of contig placements
(`SubmissionValidationPlan.java:66-74`, `.contig`), and the annotation-only flatfile path builds
another (`.annotation`, `:333-337`). Both are `fileDeleteAfterClose()`. **[PROVEN]** — this is how
the library handles assemblies too large for memory, on both sides of the seam.

### 5.5 The pipeline stages, in order

`SubmissionValidationPlan.execute()` (`:51-178`) carries the comment `// Validation Order shouldn't
be changed` (`:59`). The order, gated by `Context.getFileTypes()` (`Context.java:17-30`):

```
 1. options.init()                       validate the configuration itself
 2. MASTER                    -> createMaster()            [genome, transcriptome]
 3. CHROMOSOME_LIST           -> validateChromosomeList()  [genome]
 4. UNLOCALISED_LIST          -> validateUnlocalisedList() [genome]
 5. AGP                       -> build the .contig MapDB   [genome]
 6. ANNOTATION_ONLY_FLATFILE  -> build the .annotation MapDB + validate
 7. FASTA                     -> validateFasta()
 8. FLATFILE                  -> validateFlatfile()
 9. AGP                       -> validateAGP()
10. TSV / SAMPLE_TSV / TAX_TSV-> validateTsvfile() (+ PolySampleValidationCheck)
11. validateDuplicateEntryNames / validateUnlocalisedEntryNames
12. genome only:  registerSequences()                  merge fasta.info + flatfile.info + agp.info -> sequence.info
                  validateCovid19GenomeSize()
                  validateSequencelessChromosomes()
                  verifyUnlocalisedObjectNames()
                  validateAssemblySequenceCount(contig, scaffold, chromosome counts)
                  [server + distributed only] populateNonAgpUnplacedEntryNames(); writeUnplacedList()
    non-genome:   writeSequenceInfo()
```

**[PROVEN]**. Note stage 2: the master is built and validated **first**, before any sequence file is
read, because everything downstream needs its source feature and project.

### 5.6 The artifacts handed to the next stage

Written only when `!isWebinCLI` (or `forceReducedFlatfileCreation`, added upstream 2021-09-02 as
`ENA-4500`):

| Artifact | Written by | Contents |
| --- | --- | --- |
| `processDir/master.dat` | `MasterEntryValidationCheck.java:59-61` | the master entry, full EMBL flatfile |
| `<inputdir>/reduced/contigs.reduced.tmp` | `FileValidationCheck.java:422-437,763` | contig-level entries, **`EmblReducedFlatFileWriter`** |
| `<inputdir>/reduced/scaffolds.reduced.tmp` | `:439-453,766` | scaffold-level entries, reduced |
| `<inputdir>/chromosome.flatfile.tmp` | `:456-466,769` | chromosome-level entries, **full `EmblEntryWriter`** |
| `processDir/{fasta,flatfile,agp,sequence}.info` | `AssemblySequenceInfo.java:28-31,66-80` | Java-serialized `Map<String, AssemblySequenceInfo>` — name → (length, assemblyLevel, accession=null) |
| `processDir/unplaced.txt` | `SubmissionValidationPlan.java:455-470` | Java-serialized `Set<String>` |
| `reportDir/VALIDATION_STATS.log` | `DefaultSubmissionReporter.java:201-217` | `COUNT \t MESSAGE_KEY \t MESSAGE` per message key |

**[PROVEN]**. The contig/scaffold/chromosome asymmetry is itself informative: contigs and scaffolds
go out *reduced* (no feature table? — `EmblReducedFlatFileWriter` is worth a separate read), while
chromosomes go out in full. A test comment names the consumer:
`SubmissionValidationPlanTest.java:433` — *"also verified by comparing existing **enapro loading
flatfiles**."* **[IMPLIED]** these three `.tmp` files are putff's input.

### 5.7 The `analysis_xml` round trip — and the rewrite in the middle

This is the tightest client↔server coupling in the whole system, and it is checkable end to end.

webin-cli builds the ANALYSIS XML in
`webin-cli/.../context/SequenceToolsXmlWriter.java:51-102` and
`webin-cli/.../context/genome/GenomeXmlWriter.java:31-53`:

```
<ANALYSIS_SET><ANALYSIS alias=… center_name=…>
  <TITLE/> <DESCRIPTION/>
  <STUDY_REF accession="PRJ…"/> <SAMPLE_REF accession="SAM…"/>
  <RUN_REF accession="ERR…"/>  <ANALYSIS_REF accession="ERZ…"/>
  <ANALYSIS_TYPE><SEQUENCE_ASSEMBLY>
      <NAME/> <TYPE/> <PARTIAL/> <COVERAGE/> <PROGRAM/> <PLATFORM/>
      <MIN_GAP_LENGTH/> <MOL_TYPE/> <TPA/> <AUTHORS/> <ADDRESS/>
  </SEQUENCE_ASSEMBLY></ANALYSIS_TYPE>
  <FILES><FILE filename=… filetype="fasta|flatfile|agp|chromosome_list|unlocalised_list" checksum_method="MD5" …/></FILES>
  <ANALYSIS_ATTRIBUTES><ANALYSIS_ATTRIBUTE><TAG>SUBMISSION_TOOL</TAG>…
</ANALYSIS></ANALYSIS_SET>
```

ENA stores that document in `analysis.analysis_xml`, and the pipeline reads it back with the
matching XPaths (`EraproDAOUtilsImpl.java:484-509`):

```
/ANALYSIS_SET/ANALYSIS/ANALYSIS_TYPE/SEQUENCE_ASSEMBLY/{NAME,MOL_TYPE,TPA,AUTHORS,ADDRESS}/text()
/ANALYSIS_SET/ANALYSIS/DESCRIPTION/text()
```

and for transcriptomes, `XMLTABLE('//ANALYSIS_SET/ANALYSIS/ANALYSIS_TYPE/TRANSCRIPTOME_ASSEMBLY' … COLUMNS name, platform, program)`
(`:614-626`), matching `TranscriptomeXmlWriter.java:31-45`. **[PROVEN]** — every element the SQL
reads is an element webin-cli writes.

**But the stored XML is not what was submitted.** webin-cli writes run/analysis references as
`<RUN_REF accession="…"/>` — an attribute. The ERAPRO queries read
`/ANALYSIS_SET/ANALYSIS/RUN_REF/IDENTIFIERS/PRIMARY_ID` (`:175-176`, `:501-502`) and the result is
scraped with the regex `<PRIMARY_ID>(.*)</PRIMARY_ID>` (`EraproDAOUtilsImpl.java:644-651`). So
between submission and storage ENA **rewrites the references into the SRA canonical
`IDENTIFIERS/PRIMARY_ID` form**, presumably resolving aliases to accessions at the same time.
**[PROVEN]** that the two forms differ; **[INFERRED]** that alias resolution is what the rewrite is
for. There is an internal class named in a webin-cli comment that plausibly does it:
`GenomeXmlWriter.java:38` — `// as per SraAnalysisParser.setAssemblyInfo`. `SraAnalysisParser` does
not exist in any public ENA repo. **[IMPLIED]** it is the server-side XML intake component.

The practical consequence for a broker: **the manifest is not the record of truth; the stored
ANALYSIS XML is**, and it has already been normalised once before sequencetools ever sees it.

### 5.8 Distribution to INSDC partners

`EntryUtils.excludeDistribution(assemblyType)` (`EntryUtils.java:275-279`) returns true for exactly
three assembly types: `BINNED METAGENOME`, `PRIMARY METAGENOME`, `CLINICAL ISOLATE ASSEMBLY`.
It is consulted in four places (`SubmissionValidationPlan.java:132`, `FileValidationCheck.java:757`,
`SubmitterAccessionCheck.java:45,66`, `EntryUtils.java:266`), and the effects are:

- non-distributed assemblies get **no reduced flatfiles written** — i.e. nothing is handed to putff;
- they get **no `unplaced.txt`**;
- the entry-name-length rule is not enforced;
- binomial organism names are not required (`EntryUtils.isBinomialRequired:263-272`).

**[PROVEN]** for the mechanism. **[INFERRED, high confidence]** "distribution" here means INSDC
distribution — these three assembly types are archived by ENA but not pushed to the partners as
flatfile entries, which is exactly why the flatfile-shaped constraints are relaxed for them.
`AssemblyInfoEntry.distribute` (`:46`) is the per-assembly counterpart, never read here.

**[GAP]** Nothing in the repo describes the exchange mechanism, cadence, or payload. The
`ValidationScope.NCBI*` path (§5.1) is evidence of the **inbound** direction only.

### 5.9 The commit history, which is more candid than the docs

A survey of upstream `enasequence/sequencetools` history (the local clone is shallow, so this comes
from GitHub's API; **[PROVEN]** as to the existence and text of the commits). The messages that
matter:

| Date | Message | What it tells you |
| --- | --- | --- |
| 2019-07-22 | `ENA-3300: Brokered submissions - addition of data owner details to flat files` | the `submission_account.broker_name` path was added *for brokering* — directly relevant to Pathoplexus |
| 2019-07-30 | `ENA-3277: Add DR lines if the Analysis references to other runs or analysis` | the `RUN_REF`/`ANALYSIS_REF` → DR-line xref logic |
| 2019-09-16 | `read locus_tag prefix from era, if available` | ERAPRO's `locus_tag` table was added *after* ENAPRO's `mv_project`, which is why `LocusTagPrefixCheck` prefers it |
| 2020-06-09 | `ENA-3712: Entry project id lookup from original table` | ENAPRO's `mv_project` is a derived copy; ERAPRO's `project` is "the original table" |
| **2021-03-24** | **`isRemote changed to isWebinCLI`** | the flag was renamed, 16 files; the `// isRemote == isWebinCLI` comment is the scar |
| **2021-04-20** | **`gcs_pkg usages removed`** | another Oracle PL/SQL package (Genome Collections) was **removed from the open-source build** — an explicit de-coupling of OSS from internals |
| 2021-04-20 | `ignore_error from database moved to pipeline` | why the ERAPRO `isIgnoreErrors` query survives but is called from outside |
| 2021-09-02 | `ENA-4500: Adding forceReducedFlatfileCreation flag` | the escape hatch that lets the reduced files be produced in client mode |
| 2022-05-27 | `master comment generation code moved to sequencetools` | code migrating *in* from the closed pipeline |
| **2023-01-20** | **`Do not set status. Deprecate ST* line. Remove XML writing.`** | the EMBL internal `ST*` status line and an XML writer tree were deleted from the OSS library |
| **2023-03-22** | **`ENA-5545: updating the query to fix ORA-00600: internal error code`** | ERAPRO is Oracle, in production, and has hit Oracle internal errors |
| 2023-05-23 | `ENA-5448` | the commit that added a tracked test resource with the a development Oracle service credential — **never touched since** |
| 2023-10-19 | `Added ValidationScope enumeration comments.` | the putff annotations (§5.1) |
| 2024-10-28 | `ENA-6309: read collection_date and geo_loc_name from sample if available for all assemblies` | source qualifiers are back-filled from the BioSample, server-side |

The ticket prefixes `ENA-` and `EMD-` appear in in-tree comments too (`ENA-2825`, `ENA-4467`,
`ENA-6041`, `ENA-6938`, `EMD-2496`, `EMD-2607`, `EMD-4447`, `EMD-5315`, `EMD-5594`) —
**[INFERRED]** two Jira projects, one for the archive (`ENA`) and an older one (`EMD`, plausibly
"EMBL Data"), with `EMD` tickets predating `ENA` ones.

The direction of travel is visible: `gcs_pkg` removed (2021), `ST*` line and XML writing removed
(2023), an ERA *service* URL added alongside the JDBC connection (`ServiceConfig`, §3.3). ENA has
been steadily pulling internals *out* of the published library. The ERAPRO DAO is what is left.

---

## 6. Where the public documentation disagrees with, or omits, what the code shows

This is the section with the most value per line, so it is stated bluntly. Documentation claims were
checked against the upstream source of `ena-docs.readthedocs.io` (`enasequence/read_docs`,
mirrored locally at `/workspaces/claude-devcontainer/scratch/ena-docs-reference/read_docs/`, HEAD
`dc6ebd1`), the ENA flat-file user manual (`usrman.txt`, Release 143, March 2020), ENA release
notes, `insdc.org`, and the four most recent ENA NAR database-issue papers.

### 6.1 A flat contradiction: "full validation"

The genome-assembly submission page says, of `-validate` versus `-submit`:

> "**Full validation of your data and metadata is run regardless of which option you choose**"
> "In both cases, your prospective submission will be **validated in full**, and the result of this reported to you."
> — https://ena-docs.readthedocs.io/en/latest/submit/assembly/genome.html

The code says otherwise, in twelve enumerable places (§4.1) plus four `@RemoteExclude` classes. On a
laptop, `getEraproDAOUtils()` and `getEntryDAOUtils()` are `null`, and every check that depends on
them returns an empty `ValidationResult`. "Full validation" is not what happens; a **strict subset**
is what happens, and there is no client-side signal — no warning, no INFO message, nothing in the
`.report` file — that the subset was taken. **This is the single most important finding in this
document for a submitter.**

The only public acknowledgement anywhere that any check is server-only is a one-line caveat about
something else entirely, on the *update* page:

> "**Webin-CLI does not currently validate for this and the error will only be caught after submission.**"
> — https://ena-docs.readthedocs.io/en/latest/update/assembly.html (chromosome-name continuity)

And the nearest thing to a public statement of the architecture is one sentence in the
`sequencetools` README: *"It is used by Webin-CLI **and ENA's internal processing pipelines**."*
That sentence is upstream and predates the rest of the README (the long "Public Interface Reference"
section was added in a single unreviewed 697-line commit, `261cc1ec`, 2026-04-21, message `doc`, by
an `@ebi.ac.uk` author, pushed straight to master with no PR). The README's §3 is titled
*"Data access contracts (DB-backed)"* and says the DAOs exist *"so validation decisions are based on
live archive state"* — which is more honest than anything on readthedocs, and is only discoverable
by someone who reads a Java library's README.

### 6.2 Concepts the code relies on that the docs do not define

| Concept | In the code | In the public docs |
| --- | --- | --- |
| **`SET` dataclass** | `Entry.SET_DATACLASS`, in `dataclass.tsv`, required for every assembly master (`AssemblyLevelDataclassCheck.java:54-56`) | **Absent from every authoritative list**: not in `usrman.txt` §3.1 (10 classes), not in `relnotes.txt` "Breakdown by dataclass" (9), not on the docs' own data-classes page (10) |
| **`TLS`, `MGA`, `PRT`, `TPX` dataclasses** | in `dataclass.tsv`; `TLS` and `TSA` have keyword mappings | TLS exists only as an FTP directory name; MGA/PRT/TPX undocumented |
| **"master record" / master entry** | a first-class object with its own service, scope, validation pass and output file | one 2016 EBI news item explains the `LLLLVV000000` accession pattern; one browser UI label; the entire `submit/assembly/*` docs tree never mentions it |
| **taxonomic divisions** (PLN/FUN/PRO/HUM/…) | drive two rule tables that reject qualifiers | documented **only** in `usrman.txt`/`relnotes.txt`, never on ena-docs.readthedocs.io |
| **`ignore_errors`** | ERAPRO table + REST endpoint + a flag that mutes six specific checks *and* the genome rate limit | **not documented at all**. Closest: "In specific cases, ENA may allow the submission of genome assemblies that are giving the following errors … at the discretion of the curation team" — mechanism unnamed |
| **rate limiting** | `POST cli/submission/v2/ratelimit/`, blocks before validation, returns the blocking `analysisId` | mentioned only in a webin-cli test comment (`// cannot submit more than 1 genome within 24 hours`); no docs page states the limit |
| **`unplaced` / distribution exclusion** | `unplaced.txt`; three assembly types excluded from distribution | neither concept appears |
| **ERAPRO / ENAPRO / putff** | 19 / 2 / 3 occurrences in the `enasequence` org, essentially all in `sequencetools` | **not documented anywhere**; absent from four ENA NAR papers (2022, 2023, 2025, and the 2014 assembly-services paper) and from insdc.org. The sole other public trace in the org is an **RST comment** in `read_docs/submit/analyses.rst:93-98` containing a raw ERAPRO SQL query against `cv_file_group_format` / `cv_analysis_file_group` — invisible on the rendered site |
| **two databases at all** | `SubmissionOptions.java:136` names both | the production/presentation split is never described. The 2025 NAR paper's roadmap mentions "Migration from SQL database to noSQL databases" — the only published hint that there is a SQL database |

### 6.3 Where the docs are right, and where they are right for the wrong reason

- **Locus tags.** The docs are accurate about the registry and, usefully, warn that *"after you
  register the prefix, it will not be usable until 24 hours later."* The code explains why that
  matters in a way the docs do not: there are three sources of truth for the prefix list (§4.3), and
  the client reads the weakest. The docs never say whether webin-cli checks prefixes locally —
  it does, against a REST snapshot.
- **Accessions.** The docs correctly say the ERZ is assigned "immediately" and that GCA and sequence
  accessions come "once the genome assembly has been fully processed". The code shows the ERZ *is*
  the `analysis_id` primary key in ERAPRO (`AssemblyInfoAnalysisIdCheck.java:39`;
  `EraproDAOUtilsImpl.java:467` sets it as the master entry's primary accession), so "immediately" is
  literally "the row was inserted". The docs do not explain the GCA/"GenCol" step (the word GenCol
  appears once in the whole corpus, unexpanded) — which `AssemblyInfoEntry.gcId` and the
  `^(ERZ|GCA_)[0-9]+$` master pattern both point at.
- **INSDC exchange.** insdc.org says only "Exchanges data with other members at regular intervals".
  The one concrete number ENA publishes is *"It will take four days for it to be visible in
  GenBank"* (https://ena-docs.readthedocs.io/en/latest/faq/release.html). The 2023 NAR paper
  describes modernised exchange pipelines using "manifest files to inform partners of new/updated
  records" and "partner web service APIs to validate data". None of that appears in `sequencetools`
  — the only exchange-adjacent things in the code are the inbound `NCBI`/`NCBI_MASTER` putff scopes
  and the outbound `excludeDistribution` gate.

### 6.4 The unforced error

a tracked test resource — a plaintext Oracle password for service `a development Oracle service` on
a named internal EBI host, user `era` — has been in the public repository since commit `49bf8b35`
(2023-05-23, `ENA-5448`) and has **never been modified since**: over three years. It is the only
credential leak of its kind in the `enasequence` org (org-scoped code searches for `jdbc:oracle`,
`ebi.ac.uk:1521`, `a development Oracle service` and `an internal host` each return exactly one file, this one).

Someone on the Pathoplexus side who has a line to ENA should tell them. We should not use it, probe
it, or repeat the value.

---

## 7. What this means for a submitter like Pathoplexus

### 7.1 The mental model to hold

> `webin-cli -validate` is a **file-format and INSDC-grammar checker** that additionally does a few
> REST lookups. It is not a rehearsal of the submission. ENA re-runs the whole thing on the files
> you upload, with two databases attached, and the record it archives is built server-side from the
> stored ANALYSIS XML, not from anything your local run produced.

Three corollaries that are easy to get wrong:

1. **The `.fixed` files webin-cli writes are never submitted.** The upload list is the original files
   (`WebinCliExecutor.java:262-271`). Do not treat a local `.fixed` flatfile as "what ENA will have".
2. **A locally generated flatfile has a fake reference block** (the CLELAND placeholder, §3.5), no DR
   lines and no CC block. It is structurally complete, not representative.
3. **Some rules exist only because the client is offline.** `FT.16` (remote feature location) is a
   hard client error and a server non-issue. If you hit it, the constraint is the tool, not the archive.

### 7.2 What you can find locally, and should

Everything driven by the 47 TSV rule tables in the jar runs identically on both sides and will not
surprise you later:

- feature-key and qualifier legality, required/exclusive/deprecated qualifiers, value patterns;
- mol_type ↔ organism ↔ source-qualifier compatibility; taxonomic-division qualifier rules;
- CDS translation, gap features, `assembly_gap`, locus_tag/gene association structure;
- flatfile/FASTA/AGP/chromosome-list/unlocalised-list syntax and cross-file consistency;
- duplicate entry names, sequence counts per assembly level, COVID-19 genome size;
- keyword↔dataclass consistency and assembly-level↔dataclass rules;
- **taxonomy** — organism validity, virus/metagenome classification, submittability (a public REST
  call, §4.5), so this *is* local-testable, contrary to the brief's premise.

Dry-running with `-validate` is genuinely worth it for all of the above, and it is cheap. Do it in a
loop in CI over a representative record before you change anything about how you build flatfiles.

### 7.3 What you cannot find locally — the post-submission surprise list

Each of these implies server-side state we cannot see. **[PROVEN]** for the mechanism; the
consequence is the practical reading.

| You will only learn after submitting | Why | Message key / where |
| --- | --- | --- |
| the project accession does not exist | needs `project` / `mv_project` | `EntryProjectIdCheck9`, `EntryProjectIdCheck.java:126-132` |
| a locus-tag prefix is not registered *for a project not in your manifest* | client only has the manifest study's prefixes | `LocusTagPrefixCheck1`, `:48-66` |
| another of your assemblies already uses this sample under a different study | needs the ERAPRO `analysis`/`analysis_sample` join over your account's history | `AssemblyInfoDifferentProject` — *"Multiple assembly submissions found with a different project but the same sample: {0}"*, `AssemblyInfoSamplewithDifferentProjectCheck.java:36-42` |
| a CON component accession doesn't exist, or has the wrong length | needs ENAPRO `bioseq` | `EntryContigsCheck.java:87,93` |
| a remote feature location points at nothing | needs ENAPRO `bioseq` | `FeaturewithRemoteLocationCheck.java:80` |
| an EC number is invalid | needs ENAPRO `cv_ec_numbers` | `EC_numberCheck.java:43` |
| the accession prefix is unregistered | needs ENAPRO `cv_database_prefix` | `PrimaryAccessionCheck2`, `:51` |
| a chromosome name doesn't match the registered one | needs ENAPRO `gcs_chromosome` | `ChromosomeSourceQualifierCheck.java:68` |
| the master record already exists | needs ENAPRO `bioseq` keyed on the ERZ | `MasterEntryExistsCheck_1`, `:44-59` |
| your entry names got silently shortened | server truncates >50 chars to 30+5 | `SubmitterAccessionCheck.java:53-57` |
| chromosome-name continuity on an update | acknowledged by ENA's own docs as post-submission only | `update/assembly.html` |
| you are rate-limited | needs the account's submission history | blocks **before** validation, `WebinCliExecutor.java:210-214` |

That last one is the exception to the rule — the rate limit *is* surfaced client-side, via REST, and
it fails fast. Worth knowing it exists: for `genome` context it is checked on every validate, and it
is bypassed when ENA has set `ignore_errors` for your account+context+name.

### 7.4 Operational recommendations

1. **Treat "validated locally" as necessary, not sufficient.** If your deposition pipeline's success
   criterion is "webin-cli exited 0", widen it. The authoritative outcome is the analysis processing
   status, not the CLI exit code. ENA's Reports Service documents an **"Analysis processing statuses"**
   endpoint (`submit/general-guide/reports-service.html`); that is the thing to poll. The
   `loculus-ena-submission` flow should treat submission acceptance and processing success as two
   distinct states.
2. **Register locus-tag prefixes ≥24h ahead** (ENA documents the delay) and, because of §4.3, make
   sure the *manifest study* is the study the prefixes are registered against. If a flatfile's `PR`
   line ever names a different project than the manifest, the client will silently have no prefixes
   for it while the server will.
3. **Do not depend on entry names longer than 50 characters.** The server will rewrite them, silently
   and non-deterministically (a static counter supplies the suffix). Keep submitter accessions
   comfortably short and stable — they are your join key back to your own records.
4. **Expect the archived record to differ from your local `.fixed` output** in at least: the RL/RA
   reference block, DR cross-reference lines (from `RUN_REF`/`ANALYSIS_REF`), the CC block, source
   qualifiers back-filled from BioSample (`ENA-6309`, 2024), and `protein_id` values (minted
   server-side from `prefix_pkg`). Diffing local against retrieved-from-ENA is a legitimate QA step,
   but these differences are expected, not bugs.
5. **Know which broker fields ENA reads.** `submission_account.broker_name`, `center_name`,
   `laboratory_name`, `address`, `country` and the `submission_contact` rows are what become the
   flatfile's RL/RA lines when the manifest does not carry `AUTHORS`/`ADDRESS`
   (`EraproDAOUtilsImpl.java:214-274`). If Pathoplexus wants the *data owner* rather than the broker
   in the citation, supply `AUTHORS`/`ADDRESS` in the manifest explicitly — the ERAPRO fallback will
   name the broker account. (The feature exists precisely for this case:
   upstream `ENA-3300: Brokered submissions - addition of data owner details to flat files`.)
6. **If ENA tells you an error has been "waived"**, what has happened is a row in
   `webin_cli_ignore_errors` keyed on `(submission_account_id, context, name)` — where `name` is the
   *manifest name*. Change the manifest name and the waiver stops applying, and the genome rate limit
   comes back too (`WebinCliExecutor.java:187`).
7. **Pin the webin-cli version and record it.** The same jar carries the library that decides all of
   this, and the server runs its own build of the same library. Version drift between client and
   server is invisible and is the natural explanation for "it validated last month and fails now" (or
   the reverse).

---

## 8. Gaps — what this repo cannot tell us, and where I stopped

Stated explicitly so nobody mistakes absence for evidence.

- **The server-side caller.** Nothing in either repo constructs `SubmissionOptions` with database
  connections. The class that does — the thing that owns the ERZ, opens the two Oracle connections,
  and calls `SubmissionValidator.validate()` — is closed. **[GAP]**
- **putff itself.** Named in three comments and six enum constants. No source, no interface, no
  schema. Its inputs are inferred from what sequencetools writes. **[GAP]**
- **Accessioning.** `prefix_pkg.get_new_protein_id` is the only minting call visible. Nucleotide,
  WGS-set and GCA accessioning are entirely outside. **[GAP]**
- **`status_id`.** The values `(2, 4, 7, 8)` in `EraproDAOUtilsImpl.java:292` are a submission
  lifecycle we cannot decode. **[GAP]**
- **The ±7-day window** on `AssemblySubmissionInfo.begindate/enddate` is computed and never used in
  this repo. **[GAP]**
- **`ServiceConfig.eraServiceUrl`** — an HTTP route to ERAPRO, required for `Context.sequence`
  server-side, never called here. **[GAP]** (and a hint that JDBC is being retired.)
- **`SraAnalysisParser`** — named in a webin-cli comment, exists nowhere public. **[GAP]**
- **The CRAM reference registry implementation** of `SequenceRetrievalService`. **[GAP]**
- **INSDC exchange.** Direction, cadence and payload are undocumented publicly and invisible here.
  The `NCBI`/`NCBI_MASTER` scopes are evidence of an inbound GenBank path; nothing evidences the
  outbound one beyond the `excludeDistribution` gate. **[GAP]**
- **Version alignment.** The shipped client carries `sequencetools 2.33.2`; what version the pipeline
  runs is unknown, and `build.gradle` takes the version from `$APP_VERSION` so the source checkout
  does not name one. **[GAP]** This matters (§7.4 item 7) and is not resolvable from outside.
- **Not investigated here, by design:** how webin-cli transforms the per-record flatfile
  (source-feature rebuilding, what survives). See
  `investigations/2026-09-16-ena-webin-cli-record-construction.md`.
- **`EmblReducedFlatFileWriter`** — I established *that* contigs and scaffolds are written "reduced"
  and chromosomes are not, but did not read the writer to establish *what* is dropped. That is a
  cheap follow-up and would sharpen §5.6.

---

## Appendix A — one-screen citation index

| Claim | File:line |
| --- | --- |
| the mode flag | `api/validation/submission/SubmissionOptions.java:59` |
| the alias, and the comment admitting it | `SubmissionOptions.java:157`; `check/file/FileValidationCheck.java:987` |
| both databases named | `SubmissionOptions.java:133-137` |
| DAO construction + injection | `plan/ValidationPlan.java:89-106` |
| `@RemoteExclude` honoured | `plan/ValidationPlan.java:113,116-118` |
| severity demotion | `plan/ValidationPlan.java:136-141,154-168` |
| putff named | `ValidationScope.java:14-25`; `plan/ValidationUnit.java:70,200`; `dao/EraproDAOUtilsImpl.java:516` |
| ERAPRO SQL | `dao/EraproDAOUtilsImpl.java:167-177,214-218,252-253,282-292,327,349,369-376,405,428,442,484-509,614-626` |
| ENAPRO SQL | `dao/EntryDAOUtilsImpl.java:48-49,132,150,172,191,210,231-232,255,275,288` |
| Oracle proof | `EraproDAOUtilsImpl.java:169-176,620-625`; `EntryDAOUtilsImpl.java:232,288`; `build.gradle` (ojdbc8) |
| a development Oracle service credential | a tracked test resource` |
| master entry, two ways | `api/service/MasterEntryService.java:45-63,76-100,122-184` |
| master entry from ERAPRO | `dao/EraproDAOUtilsImpl.java:457-611` |
| `master.dat` server-only | `check/file/MasterEntryValidationCheck.java:57-65` |
| protein_id minting | `check/file/FileValidationCheck.java:985-1019`; `dao/EntryDAOUtilsImpl.java:286-296` |
| accession placeholder never filled | `api/entry/AssemblySequenceInfo.java:34`; constructed null at `FastaFileValidationCheck.java:134`, `FlatfileFileValidationCheck.java:129`, `AGPFileValidationCheck.java:148` |
| accession ranges on the assembly row | `api/entry/genomeassembly/AssemblyInfoEntry.java:29-31`; `common/accession/SequenceAccessionRangeSplitter.java:22-26` |
| locus tags, three ways | `check/entry/LocusTagPrefixCheck.java:48-66`; `webin-cli/.../service/StudyService.java:47-49,68` |
| project validity | `check/entry/EntryProjectIdCheck.java:126-132` |
| sample-reuse across projects | `check/genomeassembly/AssemblyInfoSamplewithDifferentProjectCheck.java:33-43` |
| taxonomy is public REST | `webin-taxonomy-sdk-1.2.0.jar` → `TaxonomyClient$TaxonomyUrl` (`https://www.ebi.ac.uk/ena/taxonomy/rest/%s/%s`) |
| ignore_errors, both sides | `dao/EraproDAOUtilsImpl.java:428`; `webin-cli/.../service/IgnoreErrorsService.java:68-70` |
| rate limit | `webin-cli/.../service/RatelimitService.java:43-63`; `webin-cli/.../WebinCliExecutor.java:186-215` |
| entry-name truncation | `check/entry/SubmitterAccessionCheck.java:40-58,69-75` |
| remote locations rejected client-side | `flatfile/reader/FeatureReader.java:181-184` |
| CLELAND placeholder | `check/file/FileValidationCheck.java:654-668` |
| stage order | `submission/SubmissionValidationPlan.java:51-178` |
| unplaced list | `submission/SubmissionValidationPlan.java:132-135,441-470` |
| distribution exclusion | `helper/EntryUtils.java:263-279` |
| reduced flatfiles | `check/file/FileValidationCheck.java:84-86,412-471,755-771` |
| CV rule tables ship in the jar | `validation/GlobalDataSetFile.java:13-53`; `GlobalDataSets.java:33-38`; `src/main/resources/uk/ac/ebi/embl/api/validation/data/*.tsv` |
| dataclasses | `api/entry/Entry.java:60-77`; `data/dataclass.tsv`; `helper/DataclassProvider.java:27-39`; `fixer/entry/DataclassFix.java:61-130`; `check/entry/AssemblyLevelDataclassCheck.java:51-69` |
| id grammar | `api/AccessionMatcher.java:20-52`; `AssemblyInfo{AnalysisId,SubmissionId,ProjectId}Check.java` |
| ANALYSIS XML written | `webin-cli/.../context/SequenceToolsXmlWriter.java:51-102`; `.../genome/GenomeXmlWriter.java:31-53`; `.../transcriptome/TranscriptomeXmlWriter.java:31-45` |
| ANALYSIS XML read back | `dao/EraproDAOUtilsImpl.java:484-509,614-626,644-651` |
| originals are what get uploaded | `webin-cli/.../WebinCliExecutor.java:262-271` |
| webin-cli's only entry to the library | `webin-cli/.../WebinCliContext.java:36-59` |
| the shipped jar carries the ERAPRO SQL | `fat/BOOT-INF/lib/sequencetools-2.33.2.jar` → `EraproDAOUtilsImpl.class` constant pool |
