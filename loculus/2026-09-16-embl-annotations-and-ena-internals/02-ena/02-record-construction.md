# How ENA's webin-cli actually builds the record it submits

2026-09-16. A durable reference for the Pathoplexus/Loculus team: what happens to a flatfile
between `webin-cli -context genome -validate` and the EMBL record INSDC publishes.

Builds on — and does not repeat —
[`2026-09-15-ena-flatfile-validation-resolution.md`](./2026-09-15-ena-flatfile-validation-resolution.md),
which answered the narrower question "why does Loculus's `/molecule_type` + bare `RNA` flatfile pass?".
Read this one for the general mechanism; read that one for the `/mol_type` story and the
empirical `-validate` matrix.

**Sources.** sequencetools git clone, HEAD `d731cbc` (`/workspaces/claude-devcontainer/scratch/sequencetools-src`);
webin-cli 9.0.3 (`/workspaces/claude-devcontainer/scratch/webincli-src-2026-07-25`);
shipped jars incl. `sequencetools-2.33.2.jar`
(`/home/vscode/.claude/jobs/96bed7ed/tmp/enaval/fat/BOOT-INF/lib/`);
ENA docs local copy (`/workspaces/claude-devcontainer/scratch/ena-docs-reference`).
Unqualified `file:line` refs are sequencetools; webin-cli refs are marked.
Version skew was checked with `javap` on the shipped jar for every load-bearing class — see
[§8](#8-version-skew-clone-vs-shipped-jar). Supporting subagent reports:
[`2026-09-16-ena-webin-cli-record-construction/`](./2026-09-16-ena-webin-cli-record-construction/).

---

## 0. The one-page version

### webin-cli does not build a flatfile. It builds one in memory, throws it away, and uploads yours untouched.

This is the first thing to correct, because the name "webin-**cli**" and the phrase "validation"
both mislead. In `-context genome`:

1. **webin-cli uploads your files byte-for-byte.** `WebinCliExecutor.java:262-271` (webin-cli) builds
   the upload list from `file.getFile()` — the original path you named in the manifest. Nothing is
   rewritten. Verified empirically on the 2026-09-15 variant-(h) run: the two `<FILE …
   checksum=…>` values in the generated `analysis.xml` are `b4e4833e52f9e88420ebeb674fb6e8f7` and
   `a453ecdff183f988e1155670a8b0ae0f`, which are exactly `md5sum sequences.embl.gz` and
   `md5sum chromosome_list.gz` of the inputs.
2. **The only artefacts webin-cli *generates* are two XML files**, `submit/analysis.xml` and
   `submit/submission.xml`. `GenomeXmlWriter.java:29-56` (webin-cli) shows the entire payload:
   `NAME`, `TYPE`, `PARTIAL`, `COVERAGE`, `PROGRAM`, `PLATFORM`, `MIN_GAP_LENGTH`, `MOL_TYPE`,
   `TPA`, `AUTHORS`, `ADDRESS` — all straight from the manifest — plus `STUDY_REF`, `SAMPLE_REF`
   and a `FILES` block of md5s.
3. **The record construction happens in memory, purely to decide pass/fail.** `SubmissionValidator`
   builds a *master entry* from the ENA SAMPLE, strips your source feature, substitutes its own,
   rewrites the header, and validates the result. Then it discards all of it.
4. **The writing-out is explicitly disabled for webin-cli.** Two independent gates:
   - `MasterEntryValidationCheck.java:57` — `if (!getOptions().isWebinCLI)` guards the only
     `new EmblEntryWriter(...).write(...)` of the master entry (`master.dat`).
   - `FileValidationCheck.java:756-759` — `writeEntryToFile` returns immediately when
     `getOptions().isWebinCLI`.
   A "fixed file" path *is* nevertheless allocated: `SubmissionValidator.java:337-347` re-wraps
   webin-cli's file objects into sequencetools' own `SubmissionFile` with
   `new File(file.getFile() + SequenceEntryUtils.FIXED_FILE_SUFFIX)`, and
   `FIXED_FILE_SUFFIX = ".tmp"` (`SequenceEntryUtils.java:34`). So `getFixedFileWriter`
   (`FileValidationCheck.java:412-420`) really does open `<yourfile>.tmp` — and then nothing is
   ever written to it, because `writeEntryToFile` returned early.
   **On-disk confirmation** from the 2026-09-15 runs: the input directory contains a **zero-byte
   `sequences.embl.gz.tmp`**, and `process/` contains only `flatfile.info`, `sequence.info` and an
   empty `reduced/`. There is no `master.dat` and no rewritten flatfile anywhere. If you have ever
   wondered what that stray empty `.tmp` file next to your flatfile is, that is it.
5. **ENA's server then does the construction for real**, running the same sequencetools library on
   your uploaded bytes plus the analysis XML. Almost none of the genome-context rebuild is gated on
   `isWebinCLI`, which is why the client's in-memory result predicts the published record so well.

So "what webin-cli submits" is: **your files, plus a manifest-derived XML**. "What INSDC publishes"
is a record ENA assembles server-side, in which your flatfile contributes the **sequence**, the
**entry name**, and the **non-source features** — and essentially nothing else.

### What happens to your flatfile, step by step

| # | Stage | Effect on your flatfile |
|---|---|---|
| 1 | `FlatfileFileValidationCheck.java:55-58` picks `Format.ASSEMBLY_FILE_FORMAT` for genome | The reader is told `skipSourceFeature = true` (`EmblEntryReader.java:253`) |
| 2 | `FeatureReader.java:69-80` | Your `source` feature's qualifier lines are **consumed and discarded**. An empty `source` feature is still added (`:148`). `FT.9` ("source must have mol_type") is suppressed (`:145-147`) |
| 3 | `EmblEntryReader.java:226-250` registers `AC PR DE KW DT ST* CC DR OS OC OG R*` as **skip-tag counters**, not block readers | Your header lines are counted, not parsed |
| 4 | `FlatfileFileValidationCheck.java:119` → `appendHeader(entry)` | Runs **before** validation. References, project accessions, comment and division replaced from the master (`FileValidationCheck.java:349-355`) |
| 5 | `FileValidationCheck.java:364` → `addSourceQualifiers` | `:565` `removeAllQualifiers()` on the source feature; `:566-599` adds chromosome-list qualifiers; `:601-605` copies in every master source qualifier |
| 6 | `FileValidationCheck.java:365` | Molecule type overwritten from the master (manifest `MOLECULETYPE`, default `genomic DNA`) |
| 7 | `FileValidationCheck.java:369-384` | `DE` line regenerated for genome |
| 8 | `FlatfileFileValidationCheck.java:121` → `validationPlan.execute(entry)` | **Only now** does validation run — fixers first (`EmblEntryValidationPlan.java:54`), then checks (`:55`) |
| 9 | Write time, `FeatureWriter.java:89-104` | `/organism`, `/mol_type`, `/db_xref="taxon:"` re-synthesised; any you supplied are explicitly skipped (`:113-122`); `/sub_species` silently dropped (`:123-125`) |

Your `gene`, `CDS`, `mRNA` and other non-source features pass through steps 1-7 untouched, and are
validated strictly at step 8.

### Ours vs ENA's — the complete map for `-context genome` + FLATFILE

"Ours" = something the submitter controls. "ENA's" = generated, and anything you write is ignored.

| Output element | Origin | Proof |
|---|---|---|
| **Sequence bases** | **yours** — the flatfile (or FASTA) | the only substantive thing carried through |
| **Entry name / object name** | **yours** — flatfile `AC * _<name>` (mandatory in genome: `FlatfileFileValidationCheck.java:93-97`) | matched against the chromosome list `OBJECT_NAME` |
| `gene` / `CDS` / `mRNA` / other non-source features and their qualifiers | **yours**, minus specific fixer edits | [§2](#2-what-survives-from-the-submitted-flatfile) |
| `source` feature — the whole thing | **ENA's**, from the ENA **SAMPLE** | [§1](#1-the-sample--source-feature-mapping) |
| `/organism` | ENA's — `SourceFeature.scientificName` ← `sample.getOrganism()`, re-synthesised at write time | `SourceFeatureUtils.java:114`; `FeatureWriter.java:90-94` |
| `/mol_type` | ENA's — manifest `MOLECULETYPE`, default `genomic DNA` | `MasterEntryService.java:151-155`; `FeatureWriter.java:95-99` |
| `/db_xref="taxon:N"` | ENA's — the SAMPLE's taxId | `SubmissionValidator.java:150-151`; `FeatureWriter.java:100-104` |
| `/geo_loc_name` | ENA's — SAMPLE attributes, `country[:region]` | `SourceFeatureUtils.java:206-217` |
| `/collection_date` | ENA's — SAMPLE attribute, dropped if unparseable | `SourceFeatureUtils.java:64-69` |
| `/isolate`, `/strain`, `/serotype`, … | ENA's — SAMPLE attributes, allow-listed | `EraproDAOUtilsImpl.java:66-81` |
| `/segment`, `/chromosome`, `/plasmid`, `/organelle` | ENA's — the **chromosome list** | `ChromosomeEntry.java:94-134` |
| `/submitter_seqid` | ENA's — the object name (the one qualifier preserved across the wipe) | `FileValidationCheck.java:552-557`, `:606-608`, `:868-887` |
| `assembly_gap` features | ENA's — generated from runs of N | [§5](#5-everything-generated-rather-than-submitted) |
| `ID` line: accession, `SV`, dataclass, division | ENA's | [§5](#5-everything-generated-rather-than-submitted) |
| `ID` line: topology | ENA's — chromosome list `TOPOLOGY` modifier, else master | `FileValidationCheck.java:366-368` |
| `AC` line | ENA's — assigned server-side only | webin-cli never mints an accession |
| `DE` line | ENA's — regenerated | `FileValidationCheck.java:369-384` |
| `OS` / `OC` | ENA's — taxonomy lookup on the SAMPLE taxId | |
| `RN` / `RA` / `RT` / `RL` | ENA's — manifest `AUTHORS`/`ADDRESS`, else the Webin account's registered contacts | |
| `KW` | ENA's | |
| `CC` comment | **yours**, indirectly — the manifest `DESCRIPTION` field, *not* the flatfile `DE` | `analysis.xml` `<DESCRIPTION>` |
| `DR` cross-references | ENA's — incl. the `BioSample` line from the master | `FileValidationCheck.java:353` |
| `DT` date lines | ENA's | |

The blunt summary, unchanged from 2026-09-15 and now generalised: **in `-context genome`, your
flatfile contributes the sequence, the entry name, and the annotation. Everything else that appears
in the published record is ENA's.**

---

## 1. The SAMPLE → source feature mapping

This is the part nobody on the team could explain. It is entirely **hardcoded Java** — no resource
file, no checklist, no configuration. The whole mapping lives in two files:
`SourceFeatureUtils.java` (the logic) and one enum inside `EraproDAOUtilsImpl.java` (the allow-list).

### 1.1 Where the Sample object comes from

Before any mapping happens, webin-cli has to fetch the sample. `SampleService.getSample`
(webin-cli `webin-cli-validator/.../service/SampleService.java:141-178`) prefers **BioSamples** over
ENA's own SRA record:

1. If the id starts with `SAM` (`:180-182`), try BioSamples first (`:144-152`).
2. Otherwise fetch the SRA sample via `drop-box/cli/reference/sample/{id}` (`:230-244`); this
   returns only `taxId`, `id`, `organism`, `bioSampleId`, `alias`, `canBeReferenced` (`:246-253`)
   — **no attributes**.
3. If the SRA sample carries a BioSample accession, fetch from BioSamples after all (`:163-169`) —
   "getting samples data from Biosamples is always preferred".
4. Only if BioSamples fails does it fall back to the SRA **XML** (`:173-175`) via
   `SampleXmlService`, parsing `SAMPLE_ATTRIBUTE/TAG` + `VALUE` + `UNITS`
   (`SampleXmlService.java:102-118`).

A BioSamples sample is "valid" if it has a taxId **or** an attribute literally named `organism`
(case-insensitive) (`:224-228`). From BioSamples, the attribute *names* are the JSON
`characteristics` keys (`BiosamplesService.java:157-192`), and `/organism` is taken from the
`organism` characteristic (`:143-150`); the taxId comes from the JSON `taxId`, or failing that from
an `NCBITaxon_` IRI on the organism attribute (`:194-220`).

**Consequence that matters:** the attribute names the mapping matches against are **ENA/BioSamples
sample-checklist field names**, spelled exactly as the checklist spells them —
`"geographic location (country and/or sea)"`, `"collection date"`, `"host scientific name"` — not
INSDC qualifier names. That is why the matching looks so odd.

### 1.2 `constructSourceFeature` in full

`SourceFeatureUtils.java:110-118`:

```java
public SourceFeature constructSourceFeature(Sample sample, TaxonomyClient taxonomyClient) {
  SourceFeature sourceFeature = new FeatureFactory().createSourceFeature();
  sourceFeature.setTaxId(getTaxId(sample, taxonomyClient));
  sourceFeature.setScientificName(sample.getOrganism());
  sourceFeature.setMasterLocation();
  addQualifiers(sourceFeature, sample, taxonomyClient);
  return sourceFeature;
}
```

- `getTaxId` (`:137-149`): the sample's taxId if set; else resolve by scientific name through the
  `TaxonomyClient`; else `null`.
- `setScientificName(sample.getOrganism())` — this is the *only* source of `/organism`.
- Then `addQualifiers` does the attribute walk.

Its caller, `SubmissionValidator.java:147-153`, adds one more qualifier by hand:

```java
SourceFeature sourceFeature = new SourceFeatureUtils()
    .constructSourceFeature(manifest.getSample(), new TaxonomyClient());
sourceFeature.addQualifier(
    Qualifier.DB_XREF_QUALIFIER_NAME, String.valueOf(manifest.getSample().getTaxId()));
options.source = Optional.of(sourceFeature);
```

Note it stringifies `getTaxId()` directly — a `null` taxId would produce the literal
`/db_xref="null"`. In practice `FeatureWriter` re-synthesises `/db_xref` from
`SourceFeature.getTaxId()` anyway and skips any `taxon:`-prefixed one it finds (`:119-122`), so this
hand-added qualifier is belt-and-braces. **Unverified:** whether a sample with no resolvable taxId
can reach this point in production.

### 1.3 `addQualifiers`: the attribute walk

`SourceFeatureUtils.java:160-188`. For every `Attribute` with non-null name and value, the trimmed
name is classified by `categorizeQualifiers` (`:190-204`) into one of six buckets:

| Bucket | Match rule | Matching is |
|---|---|---|
| `COUNTRY` | `.equals("geographic location (country and/or sea)")` | **exact, case-SENSITIVE** |
| `REGION` | `.equals("geographic location (region and locality)")` | **exact, case-SENSITIVE** |
| `LATITUDE` | `.contains("latitude")` | substring, case-sensitive |
| `LONGITUDE` | `.contains("longitude")` | substring, case-sensitive |
| `ISOLATION_SOURCE` | regex `^\s*environment\s*\(material\)\s*$` | anchored, case-sensitive |
| `OTHER` | everything else | → `addSourceQualifier` |

The four geo/lat-lon buckets are *stashed in local variables*, not added immediately; they are
combined after the loop (`:183-185`). Everything else goes straight to `addSourceQualifier`.

After the loop: `setLatLonQualifier`, `setGeoLocationQualifier`, `setIsolationSourceQualifier`,
`setSourceFeatureTaxon` (which hangs the full `Taxon` — and therefore the lineage used for `OC` —
off the source feature, `:245-253`), then `addExtraSourceQualifiers`.

### 1.4 `addSourceQualifier`: the allow-list — this is the gate everything passes through

`SourceFeatureUtils.java:55-88`. In order:

1. `tag = tag.toLowerCase()` (`:58`) — **so `OTHER`-bucket matching is case-insensitive**, unlike
   the four geo buckets above. This inconsistency is real, not a typo in this report.
2. **Synonym rewrite** (`:60-62`) from a four-entry map built in the constructor (`:44-47`):

   | sample attribute (lowercased) | becomes INSDC qualifier |
   |---|---|
   | `metagenomic source` | `metagenome_source` |
   | `host scientific name` | `host` |
   | `collection date` | `collection_date` |
   | `gisaid accession id` | `note` |

3. **Collection-date validation** (`:64-69`): if the tag is now `collection_date` and
   `MasterSourceQualifierValidator.isValid` says no, **return — the qualifier is silently dropped**,
   with no message. The validator (`MasterSourceQualifierValidator.java:20-34`) delegates to
   `CollectionDateQualifierCheck.isValid` (`:141-147`), which accepts eight formats
   (`CollectionDateQualifierCheck.java:41-76`): `dd-MMM-yyyy`, `MMM-yyyy`, `yyyy`, `yyyy-MM`,
   `yyyy-MM-dd`, and three `yyyy-MM-ddThh[:mm[:ss]]Z` variants, plus `from/to` ranges where both
   halves use the same format and from ≤ to (`:160-181`). Future dates are rejected (`:212-214`).
   Parsing uses `Locale.US` deliberately (`:84-95`) — under a UK locale Java 17+ wants "Sept" not
   "Sep".
4. **The allow-list** (`:71`): `MASTERSOURCEQUALIFIERS.isValidQualifier(tag)`. This is
   `Enum.valueOf(tag.toLowerCase())` over a **hardcoded 15-constant enum**
   (`EraproDAOUtilsImpl.java:66-81`), with a hardcoded exception that `PCR_primers` is never valid
   (`:85-87`):

   > `ecotype`, `cultivar`, `isolate`, `strain`, `sub_species`, `variety`, `sub_strain`,
   > `cell_line`, `serotype`, `serovar`, `environmental_sample`, `metagenome_source`,
   > `isolation_source`, `collection_date`, `geo_loc_name`

   **Anything not on that list is dropped, silently, with no message.**
5. **Null-value filtering** (`:73-76`): for value-bearing qualifiers, a value in
   `nullQualifierValues` (`EraproDAOUtilsImpl.java:54-55`) is dropped:
   `not applicable`, `not collected`, `not provided`, `restricted access`, `missing`
   (case-insensitive), as is any empty value. These are ENA's own
   [missing-value vocabulary](https://ena-docs.readthedocs.io/en/latest/submit/samples/missing-values.html),
   so a conscientiously-filled sample produces *fewer* qualifiers, not more.
6. **Valueless qualifiers** (`:78-81`): for the seven in `noValueQualifiers`
   (`EraproDAOUtilsImpl.java:56-64`) — `germline`, `macronuclear`, `proviral`, `rearranged`,
   `focus`, `transgenic`, `environmental_sample` — the qualifier is added **bare** (no value) unless
   the sample attribute's value is `NO`.
7. **The COVID-19 escape hatch** (`:85-87`): if the allow-list rejected the tag *but* the source
   feature's taxId is exactly `2697049` (SARS-CoV-2, `:51-53`) *and* the tag is one of
   `collection_date`, `geo_loc_name`, `lat_lon`, `host`, `note` (`:34-40`), it is added anyway.

**Two consequences of step 7 that surprise people:**

- **`/host` reaches the record only for SARS-CoV-2.** `host` is not in the 15-constant allow-list.
  A sample with `host scientific name = Homo sapiens` gets it rewritten to `host` by the synonym map
  — and then dropped, unless the sample is SARS-CoV-2.
- **`/lat_lon` likewise.** `setLatLonQualifier` (`:226-243`) does real work — regex-extracts the
  numeric part, formats `"<lat> N|S <lon> E|W"`, catches `NumberFormatException` — and then hands
  the result to `addSourceQualifier` under the tag `lat_lon`, which is **not on the allow-list**.
  For every organism except SARS-CoV-2 that computation is dead code.

### 1.5 `addExtraSourceQualifiers` — and a latent bug

`SourceFeatureUtils.java:90-98`: if `addUniqueName(source)` **and** the organism is prokaryotic
**and** there is no `/isolate` yet, add `/isolate = sample.getName()`.

`addUniqueName` (`:100-108`) is meant to say "don't do this if the source already has
`/environmental_sample`, `/strain` or `/isolate`". It is written as:

```java
List<Qualifier> sourceQualifiers = source.getQualifiers();
if (sourceQualifiers.contains(Qualifier.ENVIRONMENTAL_SAMPLE_QUALIFIER_NAME) || ...
```

`contains` is being passed a `String` against a `List<Qualifier>`. `Qualifier.equals`
(`Qualifier.java:216-227`) returns `false` for any non-`Qualifier` argument, so **every branch is
unreachable and `addUniqueName` always returns `true`.** For viruses this is masked by the
`isProkaryotic` gate; for a prokaryotic sample that already carries `/strain` it would wrongly add
`/isolate`. Flagged as a genuine latent bug in ENA's code, not something Loculus can trip.

### 1.6 Worked example: the live Pathoplexus record

`SAMEA117658922` → `OZ222062.1` (Pathoplexus `PP_0011CQ4.2`). The sample XML
(`https://www.ebi.ac.uk/ena/browser/api/xml/SAMEA117658922`, read-only public GET) carries 18
attributes. Tracing each through §1.3-1.5:

| # | Sample attribute | Value | Bucket | Outcome | Why |
|---|---|---|---|---|---|
| 1 | `receipt date` | 2025-01-19 | OTHER | **dropped** | not on allow-list |
| 2 | `ENA-CHECKLIST` | ERC000011 | OTHER | **dropped** | not on allow-list |
| 3 | `host disease outcome` | Deceased | OTHER | **dropped** | not on allow-list |
| 4 | `organism` | Sudan ebolavirus | OTHER | **dropped as a qualifier** | `organism` is not on the allow-list; `/organism` comes from `sample.getOrganism()` instead (§1.2) |
| 5 | `host health state` | not provided | OTHER | **dropped** | not on allow-list (and a null-value) |
| 6 | `host scientific name` | Homo Sapiens | OTHER | **dropped** | synonym → `host`; `host` not on allow-list; not SARS-CoV-2 |
| 7 | `collection date` | 2025-01-19 | OTHER | **KEPT** → `/collection_date="2025-01-19"` | synonym → `collection_date`; parses as `yyyy-MM-dd`; on allow-list |
| 8 | `scientific_name` | Sudan ebolavirus | OTHER | **dropped** | not on allow-list |
| 9 | `host subject id` | not provided | OTHER | **dropped** | not on allow-list |
| 10 | `geographic location (region and locality)` | Kampala | **REGION** | stashed | |
| 11 | `host common name` | not provided | OTHER | **dropped** | not on allow-list |
| 12 | `host sex` | Male | OTHER | **dropped** | not on allow-list |
| 13 | `isolate` | not provided | OTHER | **dropped** | on allow-list, but `not provided` is a null-value (step 5) |
| 14 | `collector name` | not provided | OTHER | **dropped** | not on allow-list |
| 15 | `collecting institution` | (long list) | OTHER | **dropped** | not on allow-list |
| 16 | `host age` | 32 | OTHER | **dropped** | not on allow-list |
| 17 | `authors` | (26 names) | OTHER | **dropped** | not on allow-list — the authors reach `RA` by a different route, §5 |
| 18 | `geographic location (country and/or sea)` | Uganda | **COUNTRY** | stashed | |

Then the post-loop combination:
- `setLatLonQualifier(null, null)` → nothing (`:227`).
- `setGeoLocationQualifier("Uganda", "Kampala")` → `"Uganda" + ":" + "Kampala"` (`:208-209`) →
  **`/geo_loc_name="Uganda:Kampala"`**.
- `setIsolationSourceQualifier(null)` → nothing.
- `setSourceFeatureTaxon` → `Taxon` for 186540, giving the `OS`/`OC` lineage.
- `addExtraSourceQualifiers` → `isProkaryotic("Sudan ebolavirus")` is false → no `/isolate`.

**Predicted source feature:** `/collection_date`, `/geo_loc_name`, plus write-time `/organism`,
`/mol_type`, `/db_xref="taxon:186540"`, plus `/segment="main"` from the chromosome list.

**Actual published record** (`https://www.ebi.ac.uk/ena/browser/api/embl/OZ222062.1`):

```
FT   source          1..18875
FT                   /organism="Sudan ebolavirus"
FT                   /segment="main"
FT                   /mol_type="genomic RNA"
FT                   /geo_loc_name="Uganda:Kampala"
FT                   /collection_date="2025-01-19"
FT                   /db_xref="taxon:186540"
```

**Exact match.** Seventeen of the sample's eighteen attributes contributed nothing; the eighteenth
(`collection date`) and a pair that merged (`country` + `region`) are the whole story.

### 1.7 Practical implications for Pathoplexus

- **`/isolate` is achievable and currently thrown away.** The sample already has an `isolate`
  attribute; it is dropped only because the value is the literal `not provided`. Putting a real
  isolate name there would surface it on every INSDC record, with no change to the flatfile.
  The same applies to `strain`, `serotype`, `serovar`, `isolation_source`, `ecotype`, `cultivar`,
  `variety`, `cell_line`, `sub_species`, `sub_strain`, `environmental_sample`, `metagenome_source`.
  **These fifteen names are the complete menu of extra source qualifiers available**, and the only
  lever is `create_sample.py`.
- **`/host` and `/lat_lon` are not achievable** for anything but SARS-CoV-2, no matter how the
  sample is filled in (§1.4 step 7).
- **Attribute names must match the ENA sample-checklist spelling exactly** for the two geo fields —
  they are case-sensitive `.equals` comparisons. `"Geographic location (country and/or sea)"` with a
  capital G would silently fall into the OTHER bucket and be dropped.
- **Nothing here is validated or reported.** A mis-spelled attribute, an unparseable collection
  date, a `not provided` placeholder — all produce silence, not a warning. The only way to know
  what ENA will keep is to trace this code or inspect the published record.
- **`SourceQualifierMissingFix`** (`fixer/sourcefeature/SourceQualifierMissingFix.java`) can *add*
  `/environmental_sample`, `/isolation_source="unknown"` and `/isolate="unknown"` later in the
  pipeline, but only for metagenome / environmental / uncultured organisms (`:91-105`, `:168-176`).
  It does not fire for named viral taxa.

---

## 2. What survives from the submitted flatfile

Short answer: **your annotation does reach INSDC.** `gene`, `CDS`, `mRNA` and every other non-source
feature are parsed with all their qualifiers, validated strictly, edited by a known list of fixers,
and written out. This is the finding that matters for loculus PR #4503 — submitting the annotated
preprocessing flatfile instead of rebuilding a bare one would in fact deposit annotation at INSDC.

### 2.1 Reader-level proof

Reconfirmed in the 2026-09-15 report and not repeated here: the same flatfile parsed with
`EMBL_FORMAT` yields `source=4q gene=2q CDS=6q`; with `ASSEMBLY_FILE_FORMAT` it yields
`source=0q gene=2q CDS=6q`. Only the **source** feature is stripped. `FeatureReader.java:69-80`
short-circuits only `if (feature.getName().equals("source") && skipSource)`.

### 2.2 sequencetools' own test oracles

The strongest available evidence is sequencetools' own regression fixtures: an input flatfile and
the `.expected` output the pipeline must produce. These are ENA's own statement of intent.

**Oracle A** — `src/test/resources/genome/fasta_flatfile/valid_genome_flatfile.txt` vs `.expected`:

| Element | Input | Expected output |
|---|---|---|
| `ID` topology | `circular` | **`linear`** |
| `ID` dataclass | `XXX` | **`WGS`** |
| `ID` division | `PLN` | **`PRO`** |
| `DE` | `Oryza sativa … whole genome shotgun sequence.` | **`Micrococcus sp. 5 strain PR1 genome assembly, contig: ENTRY_NAME1`** |
| `KW` | (absent) | **`WGS.`** |
| `OS`/`OC` | Oryza sativa + full lineage | **`Micrococcus sp. 5` / `unclassified sequences.`** |
| `RN`/`RA`/`RT`/`RL` | **four complete references** | **all removed** |
| `CC` | long comment block | **removed** |
| `DR` | `ENA;…` ×2, `ENA-CON;…` | kept, **plus `BioSample; SMEA091.`** |
| source `/organism` | `Oryza sativa Indica Group` | **`Micrococcus sp. 5`** |
| source `/strain` | (absent) | **`PR1`** — from the SAMPLE, §1 |
| source `/db_xref` | `taxon:39946` | (absent — test sample has no taxId) |
| source `/submitter_seqid` | `AAAA02:E1` | **`ENTRY_NAME1`** |
| source `/note` | (absent) | **`contig: ENTRY_NAME1`** — `FileValidationCheck.java:593-599`, WGS only |
| **`gene 212..1543 /locus_tag="SPLC1_0001"`** | present | **identical, unchanged** |
| `assembly_gap` | (absent) | **`1461..1490 /estimated_length=30 /gap_type="unknown"`** |

Note the organism changes completely between input and output: the fixture deliberately submits a
rice flatfile against a *Micrococcus* sample, to prove the flatfile's organism is ignored.

**Oracle B** — `src/test/resources/uk/ac/ebi/embl/api/validation/file/valid_genome_flatfile_pseudogene.txt`
vs `.expected` — the only fixture with a `CDS`:

| Feature | Input | Expected output |
|---|---|---|
| `gene <1..>1213` | `/gene`, `/allele`, `/locus_tag` | same three, **reordered** |
| `mRNA join(<1..34,…)` | `/gene`, `/allele`, `/circular_RNA`, `/product` | same four **plus `/locus_tag="SPLC1_0001"`**, reordered |
| `CDS join(1..34,…,920..>1212)` | `/codon_start=1`, `/gene`, `/allele`, `/note`, `/pseudogene="'unknown'"` | same five **plus `/locus_tag="SPLC1_0001"` and `/transl_table=11`**; `/pseudogene` value de-quoted to `"unknown"` |
| `gap ×3` | `/estimated_length=unknown` | **`assembly_gap`** ×3, `+ /gap_type="unknown"` |

**What this proves, concretely:**

- Locations survive verbatim, including `join(...)`, and the partial markers `<` and `>`.
- `/gene`, `/allele`, `/product`, `/note`, `/codon_start`, `/circular_RNA` survive verbatim.
- `/locus_tag` is **propagated** from the `gene` feature onto the overlapping `mRNA` and `CDS`
  (`LocusTagAssociationFix`, `GeneAssociationFix`, `CDS_RNA_LocusFix` in the fixer list, §2.3).
- **`/transl_table` is added from the SAMPLE's taxonomy, not from your flatfile** — see §2.5.
- Qualifier **order** is rewritten (`Qualifier.compareTo`, `Qualifier.java:229-236`: "the natural
  order of the qualifiers is the order in which they should appear in the flat file").
- Quoting is normalised (`QualifierValueFix`).
- `gap` features become `assembly_gap` (`GaptoAssemblyGapFeatureFix`).

### 2.3 The complete fixer list

`ValidationUnit.SEQUENCE_ENTRY_FIXES` (`plan/ValidationUnit.java:165-220`) is a hardcoded, ordered
list of ~50 fixer classes, run **before** the checks (`EmblEntryValidationPlan.java:54-55`) and only when
`isFixMode` (`:48`, default `true` per `SubmissionOptions.java:56`). The ones that touch submitter
annotation:

| Fixer | What it does to your features |
|---|---|
| `ProteinIdRemovalFix` (`:204`) | **Removes every `/protein_id`**, Severity.FIX, message `ProteinIdRemovalFix_1`: *"protein_id \"{0}\" has been deleted for feature \"{1}\", as protein_ids can only be assigned by EMBL"*. Excluded only for `ASSEMBLY_MASTER`/`NCBI`/`NCBI_MASTER` scopes, so it fires on every genome entry |
| `QualifierRemovalFix` (`:220`) | Removes `/citation` and `/compare` from all features except `old_sequence` |
| `FeatureQualifierRenameFix` (`:175`) | Renames per `feature-qualifier-rename.tsv`: `mobile_element`→`mobile_element_type`, `label`→`note`, **`country`→`geo_loc_name`**. (`molecule_type`→`mol_type` is deliberately **not** in this table — see 2026-09-15 report.) |
| `FeatureRenameFix` (`:194`) | `feature-rename.tsv`: `repeat_region`→`mobile_element`, `conflict`→`misc_difference` |
| `ObsoleteFeatureFix`, `ObsoleteFeaturetoNewFeatureFix` (`:195`,`:197`) | `obsoletefeature-to-feature.tsv` |
| `GeneAssociationFix`, `GeneAssociatedwithFeatureFix`, `GeneSynonymFix`, `LocusTagAssociationFix`, `CDS_RNA_LocusFix` (`:184-188`) | Propagate `/gene`, `/gene_synonym`, `/locus_tag` between `gene` and the features it spans — Oracle B above |
| `FeatureLocationFix` (`:192`) | Normalises locations |
| `QualifierValueFix` (`:198`) | Normalises values (de-quoting etc.) |
| `FeatureQualifierDuplicateValueFix` (`:193`) | Collapses duplicate qualifier values |
| `EC_numberValueFix`, `EC_numberfromProductValueFix` (`:199`,`:189`) | Derives/normalises `/EC_number` |
| `Transl_exceptLocationFix`, `AnticodonQualifierFix` (`:203`,`:207`) | Location arithmetic inside `/transl_except`, `/anticodon` |
| `ExperimentQualifierFix`, `LocusTagValueFix`, `Linkage_evidenceFix` (`:191`,`:205`,`:196`) | Value normalisation |
| `GaptoAssemblyGapFeatureFix` (`:217`) | `gap` → `assembly_gap` |
| `Ascii7CharacterFix` (`:173`) | Non-ASCII characters in any value |
| `ExclusiveQualifierTransformToNoteQualifierFix` (`:190`) | `exclusive-qualifiers-to-remove.tsv` — demotes conflicting qualifiers to `/note` |

Also present but operating on the (already SAMPLE-derived) **source** feature, so irrelevant to your
annotation: `GeoLocationQualifierFix`, `CollectionDateQualifierFix`, `Isolation_sourceQualifierFix`,
`HostQualifierFix`, `SourceQualifierMissingFix`, `SourceQualifierFix`, `MacronuclearQualifierFix`,
`StrainQualifierValueFix`, `Lat_lonValueFix`, `MoleculeTypeAndQualifierFix`, `Mol_typeFix`.
(`GeoLocationQualifierFix` is in fact near-dead: its `@ExcludeScope` names 13 of the 14
`ValidationScope` values, leaving only `NCBI`.)

### 2.4 What is *not* silently dropped — it errors instead

A qualifier that is not legal on a feature is an **ERROR**, not a silent removal.
`FeatureKeyCheck.java:157-164`:

```java
for (Qualifier qualifier : feature.getQualifiers()) {
  if (!validFeatureQualifiers.contains(qualifier.getName()))
    reportError(feature.getOrigin(), NOT_PERMITTED_QUALIFIER_MESSAGE, ...);
}
```

and an unknown feature key is an ERROR too (`:165-167`). The legal sets come from
`feature-key-qualifiers.tsv`, columns `key, qualifier, mandatory, single, recommended`
(`FeatureKeyCheck.java:58-73`). For `CDS` the legal qualifiers are: `gene_synonym`,
`artificial_location`, `pseudogene`, `citation`, `codon_start`, `EC_number`, `function`, `gene`,
`note`, `number`, `product`, `standard_name`, `transl_except`, `partial`, `pseudo`, `translation`,
`map`, `transl_table`, `db_xref`, `exception`, `protein_id`, `allele`, `locus_tag`, `operon`,
`old_locus_tag`, `inference`, `experiment`, `ribosomal_slippage`, `trans_splicing`, `circular_RNA`.
None is mandatory; `/translation`, `/protein_id`, `/codon_start`, `/transl_table`, `/gene`,
`/locus_tag` and others are marked single-valued.

`deprecated-qualifiers.tsv` additionally flags `Partial` and `Pseudo` as deprecated with no
replacement, and auto-replaces `specific_host` → `host`.

**Net: nothing in your annotation disappears quietly.** Either it survives, or a named fixer
rewrites it (and reports a `FIX`-severity message in the validation report), or validation fails.
The only silent drops in the whole pipeline are in the SAMPLE→source mapping (§1) and the
write-time source-qualifier suppression (`FeatureWriter.java:113-125`, which also silently drops
`/sub_species`).

### 2.5 `/transl_table` comes from the sample, not from you

`CdsTranslator.java` derives the translation table from the `Taxon` — `taxon.getGeneticCode()`
(`:319`), or the mitochondrial/plastid code when the source has an `/organelle` qualifier
(`:296-323`, `:330-364`). Then:

- If your `/transl_table` **disagrees** with the derived one, that is a **Severity.ERROR**,
  `CDSTranslator-10` (`:369-377`) — though your value is what is then used for translation
  (`:377`).
- If the derived table is not 1 and you supplied no `/transl_table`, one is **added** as a
  `Severity.FIX`, `CDSTranslator-17` (`:406-415`).

For viruses the derived code is 1 (standard), so nothing is added — matching `OZ222062.1`, which has
no `/transl_table`. Oracle B's `/transl_table=11` appears because the fixture's sample is a
bacterium. **The practical risk for Loculus: emitting a `/transl_table` that disagrees with the
sample organism's NCBI genetic code is a hard ERROR.** Emitting none is safe.

### 2.6 `/protein_id` and the live counter-example

`ProteinIdRemovalFix` removes any `/protein_id` you supply; ENA assigns its own server-side
(`FileValidationCheck.java:985-988` `assignProteinAccession`, which is a no-op in webin-cli because
`isRemote == isWebinCLI`). A live record showing the end state —
`https://www.ebi.ac.uk/ena/browser/api/embl/OZ026253`, an IPD-IMGT/HLA targeted sequence:

```
FT   CDS             join(626..698,827..1096,...)
FT                   /codon_start=1
FT                   /transl_table=1
FT                   /gene="HLA-B"
FT                   /allele="HLA-B*07:02:01:13"
FT                   /product="MHC class I antigen"
FT                   /function="antigen presenting molecule"
FT                   /protein_id="CAL0349066.1"
FT                   /translation="MLVMAPRTVLLLLSAALALTETWAGSHSMRYFYTSVSRPGRGEPR…"
```

`/translation` **is stored and published**, and `/protein_id` carries an ENA-minted `CAL…` accession.
This record also incidentally demonstrates §4: its source feature carries `/clone="AN303089"`, and
`clone` is *not* one of the fifteen allow-listed source qualifiers — so this record cannot have gone
through the genome-context rebuild. It is a targeted-sequence (`STD` dataclass, no assembly)
submission, i.e. the `-context sequence` shape.

### 2.7 Gap in the evidence, stated plainly

**I did not find a live INSDC record that is provably a `-context genome` + annotated-FLATFILE
submission carrying `CDS` features.** Probing a handful of viral and bacterial assembly accessions
turned up none with annotation, and Pathoplexus itself is not yet emitting annotated flatfiles. The
case above rests on: the reader-level proof (§2.1), sequencetools' own input/expected oracles (§2.2),
the strict-error behaviour of `FeatureKeyCheck` (§2.4), and the 2026-09-15 empirical result that
annotated flatfiles (variants h/i) validate successfully. That is strong, but it is not an
end-to-end observation of a published annotated assembly record. Worth closing by inspecting the
first Pathoplexus record submitted after the annotations change lands.

---

## 3. Does ENA validate submitted CDS translations?

**Yes — and the answer is three-way, not two-way.** Full detail in
[`01-cds-translation-validation.md`](./2026-09-16-ena-webin-cli-record-construction/01-cds-translation-validation.md).

| Submitted `/translation` | Outcome | Key | Severity |
|---|---|---|---|
| identical to the conceptual translation | pass, no message | — | — |
| differs **only** where the submitted residue is `X` (including a trailing `X` run) | **silently corrected** to the conceptual translation | `CDSTranslator-2` | **WARNING** |
| differs in any other way — wrong residue, too short, or a non-`X` tail | **rejected** | `CDSTranslator-16` | **ERROR** |
| absent or empty | **generated** from the sequence, no message at all | — | — |
| CDS carries `/pseudo`, `/pseudogene` or `/exception` | comparison skipped entirely; your value passes through unchanged | — | — |

Message texts (`ValidationMessages.properties:84`, `:98`):

- `CDSTranslator-2` = *"Expected and conceptual translations are different. Accepting the conceptual translation."*
- `CDSTranslator-16` = *"Expected and conceptual translations are different."*

### 3.1 It definitely runs in genome context

`CdsFeatureTranslationCheck` is registered in the hardcoded list
`ValidationUnit.SEQUENCE_ENTRY_CHECKS` at `plan/ValidationUnit.java:147`, and is annotated
`@ExcludeScope(validationScope = {ASSEMBLY_MASTER, NCBI, NCBI_MASTER})`
(`CdsFeatureTranslationCheck.java:25-30`). Genome flatfile entries get
`ASSEMBLY_CONTIG` / `ASSEMBLY_SCAFFOLD` / `ASSEMBLY_CHROMOSOME` (`FileValidationCheck.java:135-165`)
— none of which is excluded. It carries no `@RemoteExclude`, so it runs client-side too.

There is **no per-scope registry file**: check selection is a hardcoded enum plus the runtime
annotation filter in `ValidationPlan.java:112-134`. Only four classes in the whole library carry
`@RemoteExclude` (the `AssemblyInfo*` DB-lookup checks), so webin-cli's `-validate` is a very close
approximation of what the server will do.

### 3.2 The decisive code

`CdsTranslator.java:149-175`:

```java
if (expectedTranslation == null || expectedTranslation.length() == 0) {
    if (!(cds instanceof PeptideFeature))
        cds.setTranslation(conceptualTranslation);            // GENERATE, silently
} else {
    ImmutablePair<Boolean, Integer> comparisonRes =
        translator.equalsTranslation(expectedTranslation, conceptualTranslation);
    if (comparisonRes.left) { … }                             // exact match
    else if (!cds.isException() && !cds.isPseudo()) {
        if (acceptTranslation || comparisonRes.right > 0) {   // X-only mismatch
            cds.setTranslation(conceptualTranslation);        // OVERWRITE
            … Severity.WARNING, "CDSTranslator-2"
        } else {
            … Severity.ERROR, "CDSTranslator-16"              // REJECT
        }
    }
}
```

`Translator.equalsTranslation` (`Translator.java:627-652`) returns `(equal, xMismatchCount)`:
submitted shorter than conceptual → error; a mismatch where the *submitted* residue is `X`
increments the counter; any other mismatch aborts immediately; trailing non-`X` residues abort.
So `comparisonRes.right > 0` means *every* difference was a submitted `X`.

`acceptTranslation` has a public setter (`:264-266`) that nothing in `main` ever calls — verified in
both the clone and the shipped jar — so it is permanently `false`.

sequencetools' own tests state the intent (`CdsTranslatorTest.java:242-306`): `AXR` vs `AAR` →
`CDSTranslator-2`; trailing `XXXXX` → `CDSTranslator-2`; `ARR` vs `AAR` → `CDSTranslator-16`;
conceptual + `GIGG` → `CDSTranslator-16`.

### 3.3 The answer to "how severe were the Loculus translation bugs?"

**Genuinely wrong translations would have been caught — as hard ERRORs — and the submission would
have failed.** That is reassuring: the bugs could not have quietly deposited wrong protein sequences
at INSDC, because the submission would not have gone through at all. The relevant failure mode was
therefore *blocked submissions*, not *corrupt records*.

Two caveats worth internalising:

1. **`X`-only mismatches are corrected, and you never find out.** `CDSTranslator-2` is a WARNING, and
   `FlatfileFileValidationCheck.java:133-138` writes the report file **only** when
   `!planResult.isValid()` — which is false for a WARNING/FIX-only entry
   (`ValidationResult.java:190-197`: only ERROR makes a result invalid). So an entry whose sole
   issue is an ambiguous-residue mismatch passes silently, with no report file and no console
   message. The same gating hides every `FIX` message, including `ProteinIdRemovalFix_1`.
   **If Loculus emits `X` where ENA computes a real residue, ENA fixes it and says nothing.**
2. **Omitting `/translation` entirely is the safest option.** ENA generates it, with no message of
   any severity. Nothing is gained by computing one yourself except the opportunity to disagree.

### 3.4 The other CDS-level checks, for completeness

All ERROR unless fix mode repairs them first (`isFixMode` defaults true,
`SubmissionOptions.java:56`; fixes run before checks, `EmblEntryValidationPlan.java:54-55`):

| Condition | Key | Auto-fixed when fix mode on? |
|---|---|---|
| `codon_start` not in 1..3 | `Translator-2` | no |
| `codon_start` != 1 and not 5' partial | `Translator-3` | yes → make 5' partial |
| length not a multiple of 3 | `Translator-11` | yes → make 3' and 5' partial |
| stop codon at a 3'-partial end | `Translator-14` | yes → remove 3' partial |
| no stop codon and not 3' partial | `Translator-15` | yes → make 3' partial |
| internal stop codon | `Translator-17` | yes → add `/pseudo`, drop `/translation` |
| translation does not start with `M` | `Translator-18` | yes → make 5' partial |
| >1 trailing stop codon | `Translator-13` | no |
| >50% `X` in the translation | `Translator-20` | no |
| invalid amino acid, or a literal `*` | `CdsFeatureAminoAcidCheck` | no — ERROR in every scope |
| `/transl_table` conflicts with taxonomy | `CDSTranslator-10` | no — ERROR (§2.5) |
| `/exception` present but no `/translation` | `CDSTranslator-1` | no |
| translations match *and* `/exception` present | `CDSTranslator-3` | WARNING only |

Note how much of this **silently rewrites your locations**: five of the conditions above are
repaired by adding `<` / `>` partiality markers or a `/pseudo` qualifier. Those edits are `FIX`
severity, so — per §3.3 caveat 1 — they are invisible in webin-cli output.

The `/translation` qualifier itself has **no regex constraint**
(`feature-qualifier-values.tsv:101`, `REGEX = (null)`); the alphabet is policed by
`CdsFeatureAminoAcidCheck` instead.

### 3.5 What is inference rather than observation

The correction happens to the **in-memory** entry. In webin-cli that entry is then discarded (§0), so
the corrected translation reaches INSDC only because ENA's server runs the same code with
`isWebinCLI == false`, where `writeEntryToFile` proceeds into `EmblReducedFlatFileWriter`. That step
is **inferred from the code, not observed**.

---

## 4. The other contexts, and whether switching is realistic

Full detail in
[`02-contexts-comparison.md`](./2026-09-16-ena-webin-cli-record-construction/02-contexts-comparison.md).

### 4.1 There are six contexts, not four

`WebinCliContext.java:35-71` (webin-cli):

| `-context` | Validator | ANALYSIS_TYPE emitted |
|---|---|---|
| `genome` | `SubmissionValidator` (sequencetools) | `<SEQUENCE_ASSEMBLY>` |
| `transcriptome` | `SubmissionValidator` | `<TRANSCRIPTOME_ASSEMBLY>` |
| `sequence` | `SubmissionValidator` | `<SEQUENCE_FLATFILE>` |
| `polysample` | `SubmissionValidator` | `<ENVIRONMENTAL_SEQUENCE_SET>` |
| `reads` | `ReadsValidator` (readtools) | none — emits `EXPERIMENT` + `RUN` |
| `taxrefset` | `TxmbValidator` | `<TAXONOMIC_REFERENCE_SET>` |

`polysample` is selectable but appears **nowhere** in ENA's public docs (zero hits, case-insensitive,
across the whole local docs copy).

sequencetools has its *own*, differently-shaped `Context` enum
(`submission/Context.java:17-30`) whose `getFileTypes()` list is the master switch for the entire
validation plan — `SubmissionValidationPlan.java:51-138` gates every stage on it. Because
`Context.sequence` lists only `FLATFILE, TSV`, the sequence context **never builds a master entry,
never reads a chromosome list, never reads an AGP and never runs any assembly-level check.**

### 4.2 Per-context comparison

| | `genome` | `transcriptome` | `sequence` | `reads` |
|---|---|---|---|---|
| FLATFILE reader format | `ASSEMBLY_FILE_FORMAT` | `EMBL_FORMAT` | `EMBL_FORMAT` | n/a |
| Source feature *parsed*? | **no** — skipped | yes | yes | n/a |
| Source feature *survives*? | **no** — wiped + rebuilt | **no** — wiped + rebuilt | **yes, intact** | n/a |
| `appendHeader` behaviour | full master rebuild | full master rebuild + TSA description | early return via `addTemplateHeader` (`FileValidationCheck.java:337-344`) | n/a |
| Mandatory manifest fields | NAME, STUDY, SAMPLE, ASSEMBLY_TYPE, COVERAGE, PROGRAM, PLATFORM | NAME, STUDY, SAMPLE, PROGRAM, PLATFORM, ASSEMBLY_TYPE | **NAME, STUDY — that is all** | NAME, STUDY, SAMPLE, LIBRARY_{SOURCE,SELECTION,STRATEGY} |
| Has a `SAMPLE` field at all? | yes | yes | **no** | yes |
| CHROMOSOME_LIST | yes | no | **no** | no |
| Validation scope | `ASSEMBLY_CONTIG`/`_SCAFFOLD`/`_CHROMOSOME` | `ASSEMBLY_TRANSCRIPTOME` | `EMBL_TEMPLATE` | n/a |
| webin-cli-visible accession | ERZ (analysis) | ERZ | ERZ (ENA docs: *not exposed*) | ERX + ERR |
| Downstream INSDC accessions | GCA + per-sequence (no GCA for SARS-CoV-2) | TSA dataclass | per-sequence only, by email | run/experiment |

**The key structural fact:** `-context sequence` preserves the submitted source feature **not**
as a deliberate "trust the submitter" policy, but because it has **no SAMPLE field**
(`SequenceManifestReader.java:27-36` — verified, the string `SAMPLE` does not appear in that file).
With no sample there is no sample-derived source feature to overwrite yours with, and
`MasterEntryService.getAnalysisType` returns `null` for anything but genome/transcriptome, so no
master is built at all.

`-context sequence` **does** accept a raw FLATFILE with no checklist and no template id
(`SequenceManifestReader.java:121-122`); the ERT-template machinery is bound to **TAB** input, not to
the context.

### 4.3 Would switching Pathoplexus to `-context sequence` work? — No

The upside is real and correctly identified: your flatfile's own source feature would survive
completely intact, so `/isolate`, `/host`, `/lat_lon`, `/collection_date` and everything else would
land verbatim. But it is the wrong tool, and the objections are structural rather than cosmetic:

1. **ENA says so explicitly, twice.** `read_docs/submit/sequence.rst:40-43`: *"This submission route
   is for sets of stand-alone targeted assembled and annotated sequences only. If you intend to
   submit an annotated assembly such as a genome, please follow the assembly submission
   guidelines."* And `sequence/annotation-checklists.rst:9-11`: *"none of the information here is
   relevant to submission of annotated genome assemblies."* Plus `sequence.rst:16-19` warning
   against submitting thousands of sequences by this route without prior approval — which describes
   Pathoplexus exactly.
2. **No SAMPLE field means no BioSample linkage.** The ANALYSIS XML would carry `STUDY_REF` and
   nothing else, and the `DR BioSample;` line — which arrives via
   `entry.addXRefs(masterEntry.getXRefs())` (`FileValidationCheck.java:353`) — is on the code path
   that `sequence` skips. Pathoplexus registers a sample per sequence and depends on that link.
3. **Different accession class, and no GCA.** Genome gives ERZ → GCA + per-sequence accessions;
   sequence gives an ERZ that ENA documents as *not exposed* (`sequence.rst:26-28`) plus
   per-sequence accessions delivered by email. *Honest nuance:* ENA already withholds GCA for
   SARS-CoV-2 specifically (`assembly.rst:121-124`), so for that one organism this objection is
   weaker — but it holds for every other Pathoplexus organism.
4. **No chromosome list, so no `/segment`.** Decisive on its own for segmented viruses. You could
   hand-write `/segment` into each source feature (it *would* now survive), but you would still lose
   the assembly level, the STD-vs-WGS dataclass decision, the topology-from-chromosome-list logic
   and the sequenceless-chromosome checks. A multi-segment influenza submission stops being "one
   assembly with N replicons" and becomes "N unrelated targeted sequences".
5. **No checklist covers a whole viral genome.** The bundled set is 29 `ERT…` templates; the
   virus-specific ones are for a single CDS, a polyprotein, ssRNA(-) cRNA, UTR/NTR, satellites and
   viroids. ERT000060's own text says *"Please do not use this checklist for submitting virus
   genomes or viral coding genes."*
6. **No `MINGAPLENGTH`, so no `assembly_gap` synthesis** (`SubmissionValidator.java:311` is the only
   setter and it is genome-only). Matters less for viral consensus genomes, but it is a change.
7. **The submission would be mis-typed in the archive.** `<SEQUENCE_ASSEMBLY>` carrying assembler,
   platform, coverage and assembly type becomes a bare `<SEQUENCE_FLATFILE>` carrying nothing but
   optional AUTHORS/ADDRESS (`SequenceXmlWriter.java:29-40`). All the assembly provenance
   Pathoplexus currently supplies has nowhere to go.
8. **A hard 30,000-sequence cap** (`FileValidationCheck.java:68`), enforced for `Context.sequence`
   at `FlatfileFileValidationCheck.java:74-77`.

**The better ask.** The real constraint is one line — `FileValidationCheck.java:565`'s unconditional
`removeAllQualifiers()`. The surrounding code already knows how to preserve a single qualifier
across that wipe (`/submitter_seqid`, stashed at `:552-557` and restored at `:606-608`), so "merge
master-derived qualifiers over submitter-supplied ones instead of replacing them" is a small, local
change. Raising that with ENA — or, far more cheaply and with no ENA involvement at all, **putting
the metadata on the BioSample where §1 shows it is already read from** — both beat moving an
assembly submission into a targeted-sequence context.

### 4.4 `-context genome` with FASTA instead of FLATFILE

Worth stating because it is the actual alternative Loculus has: it changes nothing about the source
feature (identical rebuild), and simply removes the ability to submit annotation. If the annotation
work is to reach INSDC, FLATFILE is the only route.

---

## 5. Everything generated rather than submitted

Full detail, with writers and fixers for each token, in
[`03-generated-field-provenance.md`](./2026-09-16-ena-webin-cli-record-construction/03-generated-field-provenance.md).
Worked against the live record `ID   OZ222062; SV 1; linear; genomic RNA; STD; VRL; 18875 BP.`

### 5.1 The ID line, token by token

| Token | Ultimate source | Key citation |
|---|---|---|
| `OZ222062` | **server-side only** — nothing in either tree allocates a nucleotide accession | `IDWriter.java:32-38`; §5.2 |
| `SV 1` | **server-side only** for genome; no genome-context `setVersion` exists | `IDWriter.java:40-58` |
| `linear` | chromosome list `CHROMOSOME_TYPE` column, prefix before a `-` (`linear-chromosome`); else your ID line; else the master's `LINEAR` default | `ChromosomeListFileReader.java:89-96`; `FileValidationCheck.java:402-409`, `:366-368`; `MasterEntryService.java:156-157` |
| `genomic RNA` | **manifest `MOLECULETYPE`** (default `genomic DNA`), via the master, unconditionally overwriting your ID line | `MasterEntryService.java:151-155`; `FileValidationCheck.java:365` |
| `STD` | **computed**: `STD` ⇔ the entry name appears in the chromosome list; `WGS` for contig level; `CON` for AGP; `SET` for master | `FileValidationCheck.java:250-303`, `:362` |
| `VRL` | **ENA taxonomy REST service**, keyed on the source feature's taxId — not the manifest, not your ID line | `DivisionFix.java:84-110`, registered `ValidationUnit.java:170` |
| `18875 BP` | computed from the sequence bytes; your ID-line length goes to a separate field only used for master/CON entries | `SequenceReader.java:82-84`; `IDWriter.java:104-120` |

`DivisionFix.shouldSetDivision` (`:125-135`) **overwrites even a non-empty division** in every
non-NCBI scope, with special cases first: transgenic → `TGN`, `/environmental_sample` → `ENV`.

### 5.2 `AC` and the accession boundary

**webin-cli mints no nucleotide accession, and neither does sequencetools.** Across the library,
`setPrimaryAccession` is called only from the flatfile/GenBank readers and from
`EraproDAOUtilsImpl.java:467` (which sets the *master's* accession to the analysis id). The only
accession minting anywhere is for **proteins**, and that is explicitly disabled under webin-cli
(`FileValidationCheck.java:985-1010`, `if (isRemote.get()) return;`).

What exists locally is the **entry name / submitter accession**: the first token of your `ID` line,
promoted at `EmblEntryReader.java:92-97` when the format is `ASSEMBLY_FILE_FORMAT`, or from an
`AC * _name` line (`ACStarReader.java:46`). It is **mandatory** in genome context
(`FlatfileFileValidationCheck.java:93-97`, `EntryNameRequired`), normalised by
`SubmitterAccessionFix.fix` (`:58-74` — strip whitespace and quotes, map `\ / ; , |` to `_`,
coalesce `_`), capped at 50 characters (`SubmitterAccessionCheck.java:24`), and joined against the
chromosome list's `OBJECT_NAME` (which goes through the same normalisation,
`ChromosomeListFileReader.java:79` — that is what makes the join work).

The receipt webin-cli parses returns only the **ANALYSIS** accession, `ERZ…`
(`SubmitService.java:188-200`, webin-cli). `OZ222062` is assigned by ENA's loader, invisible in
these sources.

### 5.3 `DE` — a two-stage template

**Stage 1**, the master description (`SequenceEntryUtils.java:607-641`):

```java
String descriptionFormat = "%s %s %s genome assembly";
if (isTpa) descriptionFormat = "TPA: %s %s %s genome assembly";
return includeStrain  ? format(fmt, scientificName, "strain",  strainValue)
     : includeIsolate ? format(fmt, scientificName, "isolate", isolateValue)
     : format(fmt, scientificName, "", "").replaceAll("  ", "");
```

`scientificName` is the **sample organism**; `/strain` and `/isolate` come from the source feature
and are skipped when already contained in the organism name. With neither, the double-space collapse
yields exactly `"Sudan ebolavirus genome assembly"`.

**Stage 2**, the per-entry suffix (`FileValidationCheck.java:369-384` →
`Utils.setAssemblyLevelDescription`, `Utils.java:1033-1051`). For chromosome level it runs a
first-match-wins ladder over the **source feature's chromosome qualifiers** (`Utils.java:1061-1098`):

| Qualifier | Suffix |
|---|---|
| `/plasmid` | `, plasmid: <v>` |
| `/chromosome` | `, chromosome: <v>` |
| `/organelle` | `, organelle: <v>` |
| `/macronuclear` | `, organelle: macronuclear` |
| **`/segment`** | **`, segment: <v>`** |
| `/note="monopartite"` | `, complete genome: monopartite` |
| else | `, <submitterAccession>` |

Contig and scaffold levels instead get `, contig: <name>` / `, scaffold: <name>`.

So `segment: main` is the `/segment` qualifier, whose value is the chromosome list's
`CHROMOSOME_NAME` — not your `/segment` (skipped at parse time) and not your `DE` (skipped too).

**Manifest `DESCRIPTION` → `CC`, confirmed.** Read at `GenomeManifestReader.java:138-140`
(webin-cli), written to `/ANALYSIS_SET/ANALYSIS/DESCRIPTION`
(`SequenceToolsXmlWriter.java:62-63`), selected back out by that exact XPath server-side
(`EraproDAOUtilsImpl.java:502`), set as the master comment (`:576-579`), reflowed to EMBL width
(`MasterEntryService.formatComment:102-120`) and copied onto every entry
(`FileValidationCheck.java:354`). **It never touches `DE`.** Note the webin-cli branch
(`MasterEntryService.java:122-184`) sets no comment at all — the `CC` only materialises on the
server round-trip, which is why local `-validate` runs cannot show it.

### 5.4 `OS` / `OC`

Both come from the `Taxon` object hanging off the source feature's organism qualifier — i.e. from
the **ENA taxonomy REST service**, keyed on the **sample's** taxId.
`SourceFeatureUtils.setSourceFeatureTaxon` (`:245-253`) does
`taxonomyClient.getTaxonByTaxid(sample.getTaxId())` → `sourceFeature.setTaxon(taxon)`;
`SourceFeature.setTaxon` stores it inside the `OrganismQualifier`
(`OrganismQualifier.java:31-43` — `getValue()` *is* `taxon.getScientificName()`).

- `OS`: `OSWriter.java:34-48` — scientific name plus ` (commonName)` when present.
- `OC`: `OCWriter.java:34-53` — `taxon.getFamilyNames()` joined with `"; "`, terminated `"."`;
  when the lineage is absent it writes the literal **`unclassified sequences.`** (which is what the
  test oracle in §2.2 shows).

### 5.5 `RN` / `RA` / `RT` / `RL`

Two constructors in `ReferenceUtils.java`, and which runs is exactly the webin-cli vs pipeline split:

- **From the manifest** — `getSubmitterReferenceFromManifest` (`:33-52`). Inputs are the manifest
  `AUTHORS` and `ADDRESS` fields (both-or-neither; supplying one raises
  `MANIFEST_READER_MISSING_ADDRESS_OR_AUTHOR_ERROR`; the manifest help text says *"For submission
  brokers only."*). `getAuthors` (`:63-75`) splits on `,` and parses each name through
  `EmblPersonMatchHelper` into surname + initials — which is how Pathoplexus's
  `Nabadda,Susan;Sewanyana,Isaac;…` becomes `RA Nabadda S., Sewanyana I., …`. `RL` is
  `Submitted (DD-MON-YYYY) to the INSDC.` plus the address. Applied at
  `MasterEntryService.java:171-181`, **guarded on both being non-blank**.
  One hardcoded special case (`:77-79`): for `Webin-55551` only, the authors string goes into `RG`
  (consortium) instead of `RA`.
- **From the Webin account** — `constructSubmitterReference` (`:81-129`), reachable **only
  server-side**, via `EraproDAOUtilsImpl.getSubmitterReference` reading the `submission_contact`
  rows.

**What happens if the manifest omits AUTHORS/ADDRESS:** the webin-cli branch adds *no reference at
all* (there is no `else` at `MasterEntryService.java:181`), but server-side
`EraproDAOUtilsImpl.java:594-603` falls back to the **Webin submission account's registered
contacts**, and the `RL` date becomes the analysis `first_created`, not a manifest field. So the
record always gets a reference; locally you just cannot see it.

`RN [1]` is always `1`. `RT` is always empty for a `Submission` publication — neither branch ever
sets a title.

### 5.6 `KW`

Only two code paths add keywords:

1. **TPA** (`EntryUtils.java:243-247`): `Third Party Data`, `TPA`, `TPA:assembly`, gated on manifest
   `TPA=yes`, master entry only.
2. **Dataclass mirroring** (`DataclassFix.java:33-40`, `:118-128`): adds a keyword equal to the
   dataclass — but **only for `WGS, EST, GSS, HTC, STS, TSA, TLS`**. `STD` is not in that enum.

So a chromosome-level `STD` entry with `TPA=no` gets **no keywords**, and `KWWriter.java:32-53`
still emits a line, giving the literal `KW   .` seen on `OZ222062`. A contig-level entry gets
`KW   WGS.` — matching the test oracle in §2.2.

### 5.7 `/segment` and the chromosome list format

`ChromosomeListFileReader.java`: whitespace-separated (`:36`), 3 or 4 columns (`:38-43`):

| Col | Meaning | Processing |
|---|---|---|
| 1 | `OBJECT_NAME` | `SubmitterAccessionFix.fix()`, trailing `;` stripped (`:79-80`) — joins to the entry name |
| 2 | `CHROMOSOME_NAME` | `ChromosomeNameFix.fix()` (`:82-87`) |
| 3 | `CHROMOSOME_TYPE` | split on `-`: `<topology>-<type>` or bare `<type>` (`:89-96`) |
| 4 | `CHROMOSOME_LOCATION` | lower-cased, optional (`:97-107`) |

`ChromosomeNameFix` (`:17-52`) removes whitespace, maps `\ / | = ;` → `_`, and then **deletes the
words** `chromosome, chrom, chrm, chr, linkage-group, linkage group, plasmid` case-insensitively,
mapping `mitochondria` → `MT`.

The mapping to qualifiers, `ChromosomeEntry.setAndGetQualifiers(boolean virus)` (`:94-134`):

| Condition | Qualifier |
|---|---|
| `CHROMOSOME_LOCATION` set **and `!virus`** and not `Phage` | `/organelle` |
| else name set and type `plasmid` | `/plasmid=<name>` |
| else name set and type `chromosome` | `/chromosome=<name>` |
| else name set and type `segmented` **or** `multipartite` | **`/segment=<name>`** |
| (independently) type `monopartite` | `/note="monopartite"` |
| type `linkage_group` | **nothing — silent gap** (the value is a documented, accepted `CHROMOSOME_TYPE`) |

The `virus` flag is computed live from `taxonomyClient.isChildOf(<master /organism>, "Viruses")`
(`FileValidationCheck.java:578-584`). **For a virus the `CHROMOSOME_LOCATION` column is ignored
entirely** — which is why *Sudan ebolavirus* with `CHROMOSOME_TYPE = segmented` and
`CHROMOSOME_NAME = main` yields `/segment="main"`. This is undocumented.

### 5.8 `assembly_gap`

- **Scanner**: `SequenceToGapFeatureBasesCheck.java:54-154` walks the sequence bytes for runs of
  `n`, skipping runs already matched *exactly* (both endpoints) by an existing `gap`/`assembly_gap`.
- **Threshold** (`SequenceToGapFeatureBasesFix.java:55-62`): a feature is created only when the run
  length exceeds `minGapLength - 1`, or `Entry.DEFAULT_MIN_GAP_LENGTH = 10` when `minGapLength` is
  0 — i.e. **runs of ≥ 11 N by default**.
- **Which feature**: `assembly_gap` whenever the scope is in `Group.ASSEMBLY` (`:72-74`), which
  genome always is.
- **Qualifiers**: `/estimated_length = <exact run length>` and **`/gap_type="unknown"`**, hardcoded
  (`:76-78`). **No `/linkage_evidence` is ever generated**, and `Linkage_evidenceFix.java:40-53`
  actively removes any whose sibling `/gap_type` is not `within scaffold`,
  `repeat within scaffold` or `contamination` — so a generated gap can never carry one.
- **Post-pass** (`:114-147`): if ≥ 90 % of newly created gaps are exactly 100 bp, every such
  `/estimated_length="100"` is rewritten to `"unknown"`.
- **It runs in the FLATFILE path**, not just FASTA/AGP: registered at `ValidationUnit.java:212`
  with `@ExcludeScope` only `{NCBI, ASSEMBLY_TRANSCRIPTOME}`.

**A real bug worth knowing.** `SubmissionOptions.minGapLength` is **never assigned from the
manifest**: `SubmissionValidator.java:306` sets `assemblyInfo.setMinGapLength(...)` but nothing ever
sets `options.minGapLength`. So under webin-cli the manifest `MINGAPLENGTH` does **not** reach the
gap threshold and the default 10 always applies. Server-side the value does arrive via
`<MIN_GAP_LENGTH>` in the analysis XML, but that consumer is not in this tree — so
**`-validate` can disagree with the server about which gaps get features.**

### 5.9 Everything else

- **`/organism`, `/mol_type`, `/db_xref="taxon:"` are re-synthesised at write time** from
  `SourceFeature.scientificName`, `Sequence.moleculeType` and `SourceFeature.taxId`
  (`FeatureWriter.java:89-104`), and any you supplied are explicitly skipped in the copy loop
  (`:113-122`). **`/sub_species` is silently dropped at write time** (`:123-125`) despite being one
  of the fifteen allow-listed source qualifiers — an inconsistency in ENA's own code.
- **`/submitter_seqid`** is added from the object name for assembly scopes only
  (`FileValidationCheck.java:868-887`), and is the one qualifier preserved across the source wipe.
- **`/note="contig: <name>"`** is added to the source feature for `WGS`-dataclass entries
  (`FileValidationCheck.java:593-599`).
- **`DT` lines** are assigned server-side (release dates).
- **`DR` cross-references**: the `BioSample` line arrives from the master via
  `entry.addXRefs(...)` (`FileValidationCheck.java:353`); the `MD5` line is computed downstream.
- **If your flatfile has no `source` feature at all, one spanning `1..<length>` is fabricated**
  (`FileValidationCheck.java:542-551`) — which is why 2026-09-15's variant (e), with the source
  feature deleted entirely, validated successfully.
- **Feature and qualifier order are both rewritten.** Features are re-sorted by
  `Feature.compareTo` (`Feature.java:293-330`: source first, then by minimum position, then
  longest-first). Qualifiers are re-sorted into INSDC canonical order by `Qualifier.compareTo`
  (`Qualifier.java:229-246`) using the `FORDER` column of `feature-qualifier-values.tsv`
  (`organism=1, organelle=4, plasmid=5, chromosome=6, segment=8, isolate=17, mol_type=20,
  geo_loc_name=21, collection_date=26, note=85, db_xref=86, …`) — which reproduces `OZ222062`'s
  `/organism, /segment, /mol_type, /geo_loc_name, /collection_date, /db_xref` ordering exactly.
- **Your sequence is rewritten at *read* time.** `SequenceReader.java:93-110` is a translation
  table that lower-cases every IUPAC base, strips spaces and digits, and **maps `U`/`u` → `t`**.
  So a submitted RNA sequence is stored and re-emitted as DNA letters, and case is always lost.
  Relevant to Pathoplexus: there is no way to have `U` appear in an INSDC record.
- **`SQ` header and sequence layout are regenerated**: A/C/G/T/other counts tallied at write time
  (`EmblSequenceWriter.java:43-96`), body reformatted to 10-base blocks, 6 blocks per line, with a
  right-aligned running count (`:98-141`).
- **`ST *` lines are never written by this library at all** — there is an `STStarReader` but no
  `STWriter` under `flatfile/writer/embl/`. Anything you put on an `ST *` line is read and
  discarded.
- **`DT` lines are server-side only**: `DTWriter.java:33-38` needs `firstPublic`,
  `lastUpdated` and the release numbers, and no setter for those exists outside the readers — and
  the `DT` tag is itself skipped in `ASSEMBLY_FILE_FORMAT`.
- **Extra `/db_xref` entries** are synthesised from the entry's `XRef` objects
  (`FeatureWriter.java:133-149`), which is how the `BioSample` cross-reference appears.

---

## 6. Where ENA's public docs contradict or under-describe the code

This mismatch is much of why the behaviour stayed murky, so it is worth listing explicitly.
Doc references are to the local copy at `/workspaces/claude-devcontainer/scratch/ena-docs-reference/`.

1. **The source-feature rewrite is completely undocumented — and the docs warn about the wrong
   context.** A search for "source feature" across `read_docs/submit/` hits only the *targeted
   sequence* pages. **Nothing under `submit/assembly/` or `submit/fileprep/assembly.rst` mentions
   that a genome flatfile's source feature is discarded at parse time and rebuilt from the SAMPLE.**
   Meanwhile `sequence/webin-cli-flatfile.rst:34-39` carefully warns that header `XXX` fields and
   the `R*` lines are overwritten — on the page for the one context where the source feature *is*
   preserved.
2. **The canonical flatfile example tells you to fill in fields that are ignored.**
   `fileprep/flat-file-example.rst:12-13` says *"[XXX] represent values which will be generated
   automatically by the ENA processing pipeline, so anything you enter here will be overwritten"*
   — and then shows, as submitter-supplied `{…}` placeholders, exactly the two qualifiers the
   genome pipeline overwrites:
   ```
   FT   source        1..588788
   FT                 /organism={"scientific organism name"}
   FT                 /mol_type={"in vivo molecule type of sequence"}
   ```
   A submitter following this page for a genome assembly would reasonably conclude their
   `/organism` matters. It does not.
3. **`sequence/webin-cli-flatfile.rst:49`** — *"Each sequence entry must contain exactly one source
   feature… This must include one `/organism` qualifier which must match with the scientific name of
   a species-rank taxon"* — is correct for `-context sequence` and **false** for `-context genome`,
   where a flatfile with no source feature at all validates successfully (2026-09-15, variant e).
   The docs never distinguish the two.
4. **`linkage_group` is a documented `CHROMOSOME_TYPE` that produces no qualifier.**
   `fileprep/assembly.rst:104-111` lists six allowed values; `ChromosomeEntry.java:114-132` handles
   `plasmid`, `chromosome`, `segmented`, `multipartite` and `monopartite`. `linkage_group` falls
   through silently.
5. **The virus exception to `CHROMOSOME_LOCATION` is undocumented.** `fileprep/assembly.rst:120-140`
   lists eighteen allowed locations including `Virion`, `Phage`, `Proviral`, `Viroid` — and
   `ChromosomeEntry.java:102-105` ignores the whole column when the organism is a virus.
6. **`-context polysample` appears nowhere in the docs** (zero hits, case-insensitive) despite being
   a first-class selectable context with its own manifest reader and analysis type.
7. **webin-cli calls the `sequence` context "Sequence assembly"** (`WebinCliContext.java:53`), while
   the docs describe that route as "targeted sequences" and explicitly *not* for assemblies
   (`sequence.rst:12-15`, `:40-43`). The tool's own output contradicts the documentation.
8. **The genome manifest field list in the docs is incomplete** — code additionally accepts
   `ANALYSIS_REF`, `TPA`, `AUTHORS`, `ADDRESS`, `SUBMISSION_TOOL`, `SUBMISSION_TOOL_VERSION`,
   `INFO`. The last two matter for brokers like Pathoplexus.
9. **Conversely the docs list an `AGP` manifest field the reader does not declare** — no `AGP`
   field appears in `GenomeManifestReader`, although `GenomeManifest.FileType.AGP` exists and
   `SubmissionValidator.java:326-336` consumes it. *Marked unverified* — an AGP path may exist that
   was not traced.
10. **The 30,000-sequence hard cap for `-context sequence`** (`FileValidationCheck.java:68`) is not
    documented; the docs give only the soft guidance "very rarely exceed a few hundred".
11. **Nothing documents that ENA silently corrects `X`-containing translations** (§3), nor that
    `/protein_id` is always stripped and reassigned, nor that `/transl_table` is derived from the
    sample's taxonomy.

---

## 7. What this means for Pathoplexus/Loculus

Building on the four recommendations in the 2026-09-15 report, which stand:

1. **The annotation work does reach INSDC.** loculus PR #4503's premise is sound: submitting the
   annotated preprocessing flatfile rather than rebuilding a bare one would deposit `gene`/`CDS`
   features at INSDC. The `source` feature in that flatfile remains dead weight either way (§1), so
   the PR should not try to carry source metadata through it.
2. **Source metadata is a `create_sample.py` problem, always.** §1.7 gives the exact menu: fifteen
   allow-listed qualifier names, matched case-insensitively, with ENA's missing-value vocabulary
   (`not provided` and friends) silently dropping the value. `/isolate` is currently being thrown
   away purely because the sample says `not provided`. `/host` and `/lat_lon` are unreachable for
   anything but SARS-CoV-2 — do not spend effort on them.
3. **The CDS translation bugs would have blocked submissions, not corrupted records** (§3.3). But
   two ongoing risks are worth guarding:
   - Emitting a `/transl_table` that disagrees with the sample organism's NCBI genetic code is a
     hard ERROR (§2.5). Emitting none is safe.
   - Emitting `/translation` at all buys nothing — ENA generates it when absent, silently. If
     Loculus emits one containing `X` where ENA computes a residue, ENA rewrites it and reports
     nothing visible (§3.3 caveat 1).
4. **`-context sequence` is not a viable switch** (§4.3). The better lever is the BioSample.
5. **Two client/server divergences to be aware of when trusting `-validate`:**
   - `MINGAPLENGTH` never reaches the local gap threshold (§5.8), so local and server `assembly_gap`
     results can differ.
   - The `CC` comment and the fallback submitter reference only materialise server-side (§5.3,
     §5.5), so a local `-validate` cannot show you the final record's header.
6. **`FIX`- and `WARNING`-severity messages are invisible.** `FlatfileFileValidationCheck.java:133-138`
   writes the report file only when the result is *invalid*, and only `ERROR` makes it invalid. Every
   `ProteinIdRemovalFix_1`, every `CDSTranslator-2` correction, every auto-added partiality marker
   passes without a word. If Loculus ever wants to know what ENA changed, the only reliable source
   is the published record.

---

## 8. Version skew: clone vs shipped jar

The clone is HEAD `d731cbc` (no git tags, so it cannot be mapped to a release number from the repo);
the shipped artefact is `sequencetools-2.33.2.jar`. Every load-bearing class cited here was checked
with `javap` (JDK 21).

| Class / resource | Result |
|---|---|
| `SourceFeatureUtils` | identical method set; synonym map confirmed by `ldc` constants (`metagenomic source`→`metagenome_source`, `host scientific name`→`host`, `collection date`→`collection_date`, `gisaid accession id`→`note`) |
| `EraproDAOUtilsImpl$MASTERSOURCEQUALIFIERS` | identical — same 15 constants, same order |
| `EraproDAOUtilsImpl` null/no-value lists | identical `ldc_w` constants (`not applicable`, `not collected`, `not provided`, `restricted access`, `missing`; `germline`…`environmental_sample`) |
| `ValidationMessages.properties` | **byte-identical** after CR stripping |
| `FixerMessages.properties` | 2 keys newer in HEAD (`SerotypeQualifierDeleted`, `MacronuclearQualifierFix_1`); nothing cited here differs |
| `CdsTranslator` | identical decision structure confirmed in bytecode (`isException`/`isPseudo`/`acceptTranslation` branches → `CDSTranslator-2` vs `-16`) |
| `CdsFeatureTranslationCheck` | identical `@ExcludeScope{ASSEMBLY_MASTER, NCBI, NCBI_MASTER}` |
| `ProteinIdRemovalFix` | identical |
| `FileValidationCheck` | `appendHeader` → `removeReferences`/`addSourceQualifiers`/`setMoleculeType`; `addSourceQualifiers` → `removeAllQualifiers`; `writeEntryToFile`'s `isWebinCLI` early return — all present |
| `SubmissionOptions` | `isFixMode`, `isFixCds`, `ignoreErrors`, `isWebinCLI` all present |
| `ValidationUnit` | only difference across the whole check/fix list: `MacronuclearQualifierFix` is in HEAD, absent from 2.33.2 |

**Skew summary: HEAD is slightly ahead of 2.33.2 by one fixer and two message keys. Nothing cited in
this report differs between them.**

Two dead-code findings confirmed in the jar as well as the clone:
- **`SubmissionOptions.isFixCds` has no consumers at all** — it gates nothing.
- **`CdsTranslator.setAcceptTranslation` is never called**, so `acceptTranslation` is permanently
  `false`.

---

## 9. Explicitly not verified

Stated plainly, because gaps are more useful than confident guesses.

- **The server side is inferred, never observed.** Everything about what ENA's pipeline does with
  the uploaded bytes rests on the same sequencetools classes running with `isWebinCLI == false`.
  That inference is strong — the genome rebuild is almost entirely ungated, only four
  `@RemoteExclude` checks differ, and the live `OZ222062.1` record matches the static prediction
  exactly (§1.6) — but it is inference.
- **No live INSDC record was found that is provably a genome-context annotated-flatfile submission
  carrying `CDS` features** (§2.7). Close this by inspecting the first Pathoplexus record submitted
  after the annotations change lands.
- **Accession minting** (ERZ → GCA, ERZ → OZ/OA/CA) is entirely server-side and absent from both
  source trees. All statements about it are doc-sourced and labelled as such.
- **Taxonomy-dependent branches were not exercised**: `CDSTranslator-10`, the division lookup in
  `DivisionFix`, and `taxonomyClient.isChildOf(..., "Viruses")` all require live REST calls.
- **The `AGP` manifest field path for `-context genome`** could not be traced in 9.0.3 (§6 item 9).
- **`-context polysample`**: whether it is released or internal is unknown.
- **Transcriptome's final INSDC record class** beyond the `TSA` dataclass constant.
- **Whether `KW` on the live record can ever be non-trivial**: the two keyword sources in
  sequencetools (§5.6) cannot produce one for an `STD` entry, so any such content would come from a
  downstream loader not in this tree.
- **No `-submit` was ever run.** All empirical work in this report and its predecessor was
  `-validate -test` against `wwwdev.ebi.ac.uk` only, plus read-only public GETs against the ENA
  browser API for `SAMEA117658922`, `OZ222062.1` and `OZ026253`. No credential value appears in any
  file, log or command line.

---

## Appendix: supporting reports

The three subagent investigations behind §3, §4 and §5 are preserved verbatim in
[`2026-09-16-ena-webin-cli-record-construction/`](./2026-09-16-ena-webin-cli-record-construction/):

| File | Covers |
|---|---|
| `01-cds-translation-validation.md` | Q3 — CDS translation validation, the fixer inventory, message severities, `ProteinIdRemovalFix`, full jar-vs-clone skew check |
| `02-contexts-comparison.md` | Q4 — all six contexts, per-context manifest fields, the `-context sequence` assessment, doc contradictions |
| `03-generated-field-provenance.md` | Q5 — every generated element with its writer, fixer and ultimate source |

They contain more detail than is summarised here, including several findings not carried up.
