# Why Loculus's `/molecule_type` + bare `RNA` flatfile passes at ENA

2026-09-15. Resolves the open question left by the six-error standalone reproduction:
`ena-submission`'s flatfile carries two constructs INSDC does not allow, yet every
Pathoplexus assembly submission succeeds. Answered by reading webin-cli + sequencetools
and by running webin-cli `-validate -test` against ENA's dev service.

## Answer

**Both constructs are unreachable in the code path Loculus actually uses, because
`-context genome` never looks at the flatfile's source feature or its ID-line molecule
type.** The genome path parses flatfiles with `EmblEntryReader.Format.ASSEMBLY_FILE_FORMAT`,
which sets `skipSourceFeature = true`: the reader consumes the `source` feature's qualifier
lines and throws them away, so `/molecule_type` never becomes a `Qualifier` and the
`FT.9` "source feature must have mol-type" check is explicitly suppressed for that format.
Then, before the entry reaches `EmblEntryValidationPlan` at all, `FileValidationCheck.appendHeader`
calls `entry.getPrimarySourceFeature().removeAllQualifiers()` and re-populates the source
feature from a *master entry* built from the ENA **SAMPLE** record, and overwrites
`entry.getSequence().setMoleculeType(...)` with the master's molecule type, which comes from
the manifest's `MOLECULETYPE` field (defaulting to `genomic DNA`). So the flatfile's ID-line
`RNA` is discarded too. The standalone reproduction saw six errors because it drove
`EmblEntryValidationPlan` directly with `Format.EMBL_FORMAT` — the `-context sequence` reader
— skipping both the format switch and `appendHeader`. Neither candidate hypothesis in the
brief is quite right: it is **not** a FIX-severity fixer silently correcting the value
(no fixer touches it), and it is not a *server-side* rebuild — the rebuild happens
**client-side, inside webin-cli, before validation**, and the same code runs again server-side
for the same reason. Empirically confirmed: a flatfile whose source feature says
`/organism="Homo sapiens"`, `/molecule_type="THIS IS NOT A MOLTYPE"`, `/country="Atlantis"`,
`/collection_date="not-a-date"` validates **successfully**, and so does one with no source
feature at all.

## Code path: `-context genome` + `FLATFILE`, file:line

Repos read: webin-cli 9.0.3 sources at `/workspaces/claude-devcontainer/scratch/webincli-src-2026-07-25`,
sequencetools cloned to `/workspaces/claude-devcontainer/scratch/sequencetools-src` (HEAD, ~2.36;
every claim below re-verified against the shipped `sequencetools-2.33.2.jar` — see "Verified against
the shipped jar").

1. **Plugin selection.** `WebinCliContext.java:36-41` maps `genome` to
   `uk.ac.ebi.embl.api.validation.submission.SubmissionValidator` (sequencetools), *not* to
   `EmblEntryValidationPlan`. `WebinCliExecutor.java:138` calls `getValidator().validate(manifest)`.

2. **`SubmissionOptions` construction.** `SubmissionValidator.java:112-242`
   (`mapManifestToSubmissionOptions`):
   - `:147-153` — **the source feature is built from the SAMPLE**, not from the flatfile:
     `new SourceFeatureUtils().constructSourceFeature(manifest.getSample(), new TaxonomyClient())`,
     plus `/db_xref` = the sample's taxId. This becomes `options.source`.
   - `:155` `options.isWebinCLI = true`; `:211` `options.context = Context.genome`;
     `:309` `assemblyInfo.setMoleculeType(manifest.getMoleculeType())` — the manifest's
     `MOLECULETYPE` field.
   - Fix mode is on by default (`SubmissionOptions.java:56-57`, `isFixMode = true`, `isFixCds = true`)
     but is irrelevant here: no fixer renames `molecule_type`.
   - `ValidationScope` is not set here; it is set per-entry at `FlatfileFileValidationCheck.java:99-102`.

3. **`SubmissionValidationPlan`, not `EmblEntryValidationPlan`.** `SubmissionValidator.java:63`
   runs `new SubmissionValidationPlan(options).execute()`. That plan's order
   (`SubmissionValidationPlan.java:60-93`) is: `createMaster()` → chromosome list → … →
   `validateFlatfile()`. The master is built **first**, and the flatfile validation depends on it.

4. **The master entry.** `MasterEntryValidationCheck.java:48-50` →
   `MasterEntryService.createMasterEntry`. For webin-cli, `MasterEntryService.java:122-169`:
   - `:151-155` `masterEntry.getSequence().setMoleculeType(infoEntry.getMoleculeType() == null ? "genomic DNA" : infoEntry.getMoleculeType())` —
     i.e. the **manifest's** `MOLECULETYPE`, or `genomic DNA`.
   - `:140`, `:164` `SourceFeature source = options.source.get(); … masterEntry.addFeature(source)` —
     the SAMPLE-derived source feature.

5. **The flatfile reader drops the source feature.** `FlatfileFileValidationCheck.java:55-58`:
   ```java
   Format format = options.context.get() == Context.genome
       ? Format.ASSEMBLY_FILE_FORMAT
       : Format.EMBL_FORMAT;
   ```
   `EmblEntryReader.java:223-254` registers the `ASSEMBLY_FILE_FORMAT` block readers and ends with
   `skipSourceFeature = true` (`:253`). That flag reaches `FeatureReader` via
   `EmblEntryReader.java:268`. In `FeatureReader.readLines()`:
   - `:69-80` — if the feature is `source` and `skipSource`, every following line is consumed until
     the next feature key, so **no qualifier is ever added**.
   - `:145-147` — `if (!isReducedFlatfile && (feature instanceof SourceFeature) && !moltypeFound && !skipSource) error("FT.9")`.
     The `&& !skipSource` is what suppresses the `FT.9` the standalone run saw.
   - `:148` — the (now empty) source feature is still `entry.addFeature(feature)`d.
   The ID line's molecule type *is* parsed (`IDReader.java:107-112`) but **not validated** there —
   the `error("ID.3")` is commented out.

6. **`appendHeader` overwrites what is left.** `FlatfileFileValidationCheck.java:119` calls
   `appendHeader(entry)`; only at `:121` does `validationPlan.execute(entry)` run. In
   `FileValidationCheck.appendHeader` (`FileValidationCheck.java:335-393`):
   - `:349-355` — the flatfile's references, project accessions, comment and division are **removed**
     and replaced with the master's.
   - `:364` → `addSourceQualifiers(entry)`; inside it, `:562` `source = sharedInfo.masterEntry.getPrimarySourceFeature()`,
     `:565` `entry.getPrimarySourceFeature().removeAllQualifiers()`, `:601-605` copy every master
     source qualifier onto the entry.
   - `:365` — `entry.getSequence().setMoleculeType(sharedInfo.masterEntry.getSequence().getMoleculeType())`.
     **This is where the ID line's bare `RNA` dies.**
   - `:369-380` — for genome, even the `DE` line is regenerated from the master description.

7. **Why the value is nonetheless correct on output.** `FeatureWriter.java:95-99` synthesises
   `/mol_type` for a source feature from `entry.getSequence().getMoleculeType()` at write time;
   `/organism` and `/db_xref` likewise. So the source feature never needs to carry `mol_type`
   in memory. `MoltypeExistsCheck` (`check/entry/MoltypeExistsCheck.java:30-45`) is satisfied by
   the sequence-level molecule type alone, and `EntryMolTypeCheck` (`check/entry/EntryMolTypeCheck.java:46-65`)
   checks that same, already-overwritten, value.

8. **Server side.** webin-cli uploads the flatfile **byte-for-byte unmodified** (verified: the
   `validate.json` `uploadFileList` md5 equals the md5 of the input `sequences.embl.gz`), together
   with an `analysis.xml` carrying `<MOL_TYPE>` from the manifest. ENA's internal pipeline runs the
   same `SubmissionValidationPlan`, with the master entry built from the submitted XML/ERAPRO
   instead (`MasterEntryService.java:76-100`); the `Context.genome → ASSEMBLY_FILE_FORMAT` switch
   and `appendHeader` are **not** conditioned on `isWebinCLI`, so the source feature is skipped and
   rebuilt there too. Confirmed end-to-end against live INSDC data below.

### `-context sequence` would behave differently

`FlatfileFileValidationCheck.java:56-58` gives `sequence` the `EMBL_FORMAT` reader (source feature
parsed, `FT.9` armed), and `appendHeader` returns early at `FileValidationCheck.java:337-344` via
`addTemplateHeader` without rebuilding the source. That is exactly the configuration the standalone
`EmblEntryValidationPlan` driver reproduced. Loculus never uses it —
`ena_submission_helper.py:654,730` type the context as `Literal["genome", "reads"]` — but it is the
reason the six errors are real, not an artefact.

## Empirical results

All runs `-context genome -validate -test`, webin-cli **9.0.3** (the version pinned in
`ena-submission/environment.yml`), against `wwwdev.ebi.ac.uk` only. `-submit` was never passed.
Credentials supplied through `-passwordEnv`, never on a command line.

Flatfiles (a) and (b) were produced by calling the **real** `ena_deposition.ena_submission_helper.create_flatfile`
(script at `/tmp/enaflat/gen.py`), organism `EnaOrganismDetails(molecule_type=GENOMIC_RNA, scientific_name="Severe acute respiratory syndrome coronavirus 2")`,
12 kb sequence; the manifest mirrors `create_manifest`'s field set.

| # | Flatfile | Manifest | Result |
|---|---|---|---|
| a | as `create_flatfile` emits today: source-only, `/molecule_type="genomic RNA"`, ID line `RNA` | `MOLECULETYPE genomic RNA` | **validated successfully** |
| b | (a) with `/mol_type` and ID line `genomic RNA` | same | **validated successfully** |
| c | (a) but `/organism="Homo sapiens"`, `/molecule_type="THIS IS NOT A MOLTYPE"`, `/country="Atlantis"`, `/collection_date="not-a-date"` | same | **validated successfully** |
| e | (a) with the whole `source` feature deleted | same | **validated successfully** |
| f | (a) but ID line `; linear; NOT_A_MOLTYPE; ;` | same | **validated successfully**; `analysis.xml` still `<MOL_TYPE>genomic RNA</MOL_TYPE>` |
| g | (a) unchanged | `MOLECULETYPE` **omitted** | **validated successfully**; `analysis.xml` `<MOL_TYPE>genomic DNA</MOL_TYPE>` — an RNA virus silently recorded as DNA |
| h | annotated flatfile (source + 2 gene + 2 CDS, 18.9 kb) with `/molecule_type` + bare `RNA` | `MOLECULETYPE genomic RNA` | **validated successfully** |
| i | (h) with `/mol_type` + `genomic RNA` | same | **validated successfully** |

(a) and (b) are byte-identical apart from the two lines under test, and produce byte-identical
validation outcomes. (c), (e) and (f) are the controls that prove the source feature and ID-line
molecule type are *discarded*, not merely tolerated. (g) shows where the real molecule type comes
from. (h)/(i) show the same holds once the annotations PR starts emitting gene/CDS features.

### Reader-level proof, against the shipped 2.33.2 jar

`ReadCmp.java` (at `/tmp/enaflat/ReadCmp.java`) parses the same file twice, run against
`fat/BOOT-INF/lib/*.jar`:

```
===== format=EMBL_FORMAT               ===== format=ASSEMBLY_FILE_FORMAT
  feature source qualifiers=4            feature source qualifiers=0
      /molecule_type="genomic RNA"       feature gene   qualifiers=2
      /organism="…"                          /gene="NPEbolaSudan"
      /country="…"                       feature CDS    qualifiers=6
      /collection_date="…"                   /gene="NPEbolaSudan"
  READER MSG … messageKey=FT.9 …       (no messages)
```

Only the **source** feature is stripped; `gene`/`CDS` keep all their qualifiers. So annotations
submitted via the flatfile do reach ENA — the source feature does not.

### Verified against the shipped jar

`javap -p -c` on `sequencetools-2.33.2.jar`'s `FileValidationCheck.class` confirms 2.33.2 has the
same shape as the HEAD source quoted above: `appendHeader` calls `removeReferences`, then
`addSourceQualifiers`, then `Sequence.setMoleculeType`; `addSourceQualifiers` calls
`SourceFeature.removeAllQualifiers()`. The reader behaviour is proven directly by `ReadCmp`
running on that jar.

### End-to-end: a live Pathoplexus record

`https://www.ebi.ac.uk/ena/browser/api/embl/OZ222062.1` (Pathoplexus `PP_0011CQ4.2`,
`PRJEB85569` / `SAMEA117658922`):

```
ID   OZ222062; SV 1; linear; genomic RNA; STD; VRL; 18875 BP.
DE   Sudan ebolavirus genome assembly, segment: main
OS   Sudan ebolavirus
FT   source          1..18875
FT                   /organism="Sudan ebolavirus"
FT                   /segment="main"
FT                   /mol_type="genomic RNA"
FT                   /geo_loc_name="Uganda:Kampala"
FT                   /collection_date="2025-01-19"
FT                   /db_xref="taxon:186540"
FT   assembly_gap    1..104
```

Nothing here came from the flatfile Loculus generated. `/mol_type` is correct; `/geo_loc_name`
replaces the flatfile's `/country` with a *differently formatted* value; `/segment` comes from the
chromosome list; `/db_xref` from the sample taxId; `assembly_gap` features are generated from runs
of N; the `DE` is ENA's; the flatfile's `DE` ("Original sequence submitted to …") reappears as a
`CC` comment, i.e. from the manifest `DESCRIPTION`. **The only thing Loculus's flatfile contributes
in genome context is the sequence and the entry name.**

### What `-validate` actually requires

Not just files — it is a live, authenticated operation against the test service:

- `STUDY` must resolve via `drop-box/cli/reference/project/{id}` and `SAMPLE` via
  `drop-box/cli/reference/sample/{id}` on the **same tier** (`wwwdev` for `-test`), returning
  `canBeReferenced: true`. Public accessions owned by someone else are fine.
- The **sample's organism must be taxonomically compatible with the manifest `MOLECULETYPE`**, and
  this is the *first* thing that fails. With `MOLECULETYPE genomic RNA` and a bacterial or
  nematode sample, `createMaster()` aborts with
  `MASTER.report: Organism must belong to one of "Riboviria, Deltavirus, …" when molecule type is "genomic RNA"`
  and the flatfile is never read. Use an RNA-virus sample — `SAMD00261561` (SARS-CoV-2,
  taxid 2697049) works.
- Mandatory manifest fields: `NAME`/`ASSEMBLYNAME`, `STUDY`, `SAMPLE`, `ASSEMBLY_TYPE`,
  `COVERAGE`, `PROGRAM`, `PLATFORM`, plus a `FLATFILE` (or `FASTA`) and, for a chromosome-level
  assembly, `CHROMOSOME_LIST`. `ASSEMBLY_TYPE isolate` is accepted and normalised to
  `clone or isolate`.
- `-outputDir` must exist and be writable (webin-cli will not create it).
- It also calls the ignore-errors and genome rate-limit services with the credentials; both are
  read-only. It writes `submit/analysis.xml` and `submit/submission.xml` locally but uploads
  nothing and submits nothing without `-submit` (`WebinCli.java:291-292`).

## What Loculus should do

**The `/mol_type` fix is hygiene, not a bug fix. It changes nothing about what INSDC stores, and
not making it changes nothing either.** Concretely:

1. **`ena-submission/src/ena_deposition/ena_submission_helper.py:454 create_flatfile` — fix it
   anyway, but not as a priority and not with a claim that it fixes a submission problem.**
   Applying it is a two-line change with a demonstrated no-op outcome ((a) vs (b) above). The
   reasons to do it are that the generated artifact is what humans and other tools read, that
   `/molecule_type` is simply not an INSDC qualifier, and that the constructs would become real
   errors the moment anyone reuses this writer under `-context sequence` or validates the file with
   ENA's own standalone tooling. A commit message claiming "ENA rejects both of these" is wrong for
   the genome path and should be reworded.
2. **The same applies to the already-committed fix in
   `preprocessing/nextclade/src/loculus_preprocessing/embl.py` (branch `fix-embl-annotation-translation`,
   commit `ecc8b7e44`).** It is correct and worth keeping — variants (h)/(i) show the annotated
   flatfile validates either way, so the value is hygiene plus future-proofing, not unblocking.
   The `gene`/`CDS` features in that writer *are* parsed and validated by ENA, so the rest of that
   branch's work (codon_start, strand, splicing, partial markers) is where the real risk lives.
3. **Delete, or at least stop trusting, the rest of the source feature.** `/organism`, `/country`
   and `/collection_date` in `create_flatfile` are dead weight in the genome path: ENA takes all
   three from the SAMPLE record. If a geo-location or collection date is wrong at INSDC, the bug is
   in `create_sample.py`, never in `create_flatfile`. The same goes for the `OS`/`OC`, `RN`/`RA`
   and `DE` lines, all of which `appendHeader` replaces. Keeping them invites exactly the kind of
   false lead this investigation chased.
4. **Add a guard on the manifest's `MOLECULETYPE`.** Variant (g) is the one genuine hazard found:
   if `AssemblyManifest.moleculetype` were ever `None`, ENA would silently record `genomic DNA` for
   an RNA virus, with no error anywhere. `create_assembly.py:163` currently always sets it from
   `ena_organism.molecule_type`, so this is a latent rather than live risk — worth a test, since
   nothing downstream would catch it.
5. **Do not "fix" `feature-qualifier-rename.tsv`'s missing `molecule_type` → `mol_type` mapping.**
   Its absence is not why this works, and the genome path never consults it for source qualifiers.

## Reproduction

- Flatfile generator: `/tmp/enaflat/gen.py` (imports `ena_deposition` from the clone at
  `/workspaces/claude-devcontainer/scratch/2026-09-15-loculus-embl-fix`; run under
  `uv run --with biopython --with pydantic --with python-dotenv --with orjson … python /tmp/enaflat/gen.py`).
- Reader comparison: `/tmp/enaflat/ReadCmp.java`, compiled against
  `/home/vscode/.claude/jobs/96bed7ed/tmp/enaval/fat/BOOT-INF/lib/*.jar`.
- webin-cli: `java -jar /home/vscode/.claude/jobs/96bed7ed/tmp/enaval/wcli.jar -context genome -manifest manifest.tsv -userName "$USERNAME" -passwordEnv WEBIN_PW -inputDir . -outputDir out -validate -test`
  with `set -a; . /workspaces/claude-devcontainer/.secrets/ena-nonbroker; set +a; export WEBIN_PW="$PASSWORD"`.
  Variant dirs under `/tmp/enaflat/{a,b,c,e,f,g,h,i}`.
