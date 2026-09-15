# ENA webin-cli / sequencetools: provenance of every generated EMBL record element

**Question addressed:** in `-context genome` with a `FLATFILE`, webin-cli + sequencetools largely
*rebuild* the EMBL record rather than passing the submitter's through. For a live published record
(Pathoplexus OZ222062.1, *Sudan ebolavirus*, `segment: main`), pin down the **origin of every
generated element** — which are synthesised, from what input, and where that is proved in source.

**Method:** static source analysis only. No network calls, no webin-cli runs, no credentials.

**Sources on disk**

| Symbol | Path | Version |
|---|---|---|
| `ST/` | `/workspaces/claude-devcontainer/scratch/sequencetools-src/src/main/java/` | git HEAD `d731cbc` |
| `STR/` | `/workspaces/claude-devcontainer/scratch/sequencetools-src/src/main/resources/` | same |
| `WC/` | `/workspaces/claude-devcontainer/scratch/webincli-src-2026-07-25/webin-cli/src/main/java/` | webin-cli 9.0.3 |
| jars | `/home/vscode/.claude/jobs/96bed7ed/tmp/enaval/fat/BOOT-INF/lib/` | `sequencetools-2.33.2.jar`, `webin-taxonomy-sdk-1.2.0.jar` |

---

## 0. The single most important structural finding (read this first)

Two things together explain nearly everything below.

### 0a. In `-context genome`, most of the submitter's flat file is discarded *at parse time*

`ST/uk/ac/ebi/embl/api/validation/check/file/FlatfileFileValidationCheck.java:55-58` selects
`EmblEntryReader.Format.ASSEMBLY_FILE_FORMAT` whenever context is `genome`.

In `ST/uk/ac/ebi/embl/flatfile/reader/embl/EmblEntryReader.java:223-252`, that format registers
these tags through `addSkipTagCounterHolder(...)` rather than `addBlockReader(...)`:

```
AC (226) PR (227) DE (228) KW (229) DT (230) ST* (232) CC (237) DR (238)
OS (239) OC (240) OG (241) RA (243) RC (244) RG (245) RL (246) RN (247)
RP (248) RT (249) RX (250)      ... and line 251:  skipSourceFeature = true;
```

`addSkipTagCounterHolder` puts the tag in a *skip* set
(`ST/uk/ac/ebi/embl/flatfile/reader/EntryReader.java:88-91`, `:113-115`), and
`ST/uk/ac/ebi/embl/flatfile/reader/embl/EmblLineReader.java:67-76` makes `isSkipLine()` true for
those tags, which `ST/uk/ac/ebi/embl/flatfile/reader/LineReader.java:286` and `:309` act on with a
bare `continue` — **the line is dropped before any block reader ever sees it**.

`skipSourceFeature = true` is passed into
`ST/uk/ac/ebi/embl/flatfile/reader/FeatureReader.java:44-48`; at `:68-80` the source feature's
*qualifiers* are skipped wholesale (loop reads lines until the next feature), while the bare
`source` feature object — name + location only — is still added at `:148`.

**Consequence:** the submitter's `DE`, `KW`, `OS`, `OC`, `OG`, `CC`, `DR`, `DT`, `AC`, `PR`, `ST*`
and their whole reference block (`RN/RA/RC/RG/RL/RP/RT/RX`), plus **every qualifier on their
`source` feature**, never enter the in-memory `Entry` at all. They are not "overwritten" — they are
never read. Only `ID`, `AC *`, `CO`, `SQ`, `AH`, `FH`, `AS`, the sequence, and **non-source
features** survive.

### 0b. webin-cli writes no EMBL record locally; the public record is built server-side

`ST/uk/ac/ebi/embl/api/validation/check/file/FileValidationCheck.java:755-759`
(`writeEntryToFile`) returns immediately when `options.isWebinCLI` is true (and
`forceReducedFlatfileCreation` defaults to `false`,
`ST/uk/ac/ebi/embl/api/validation/submission/SubmissionOptions.java:60`). Likewise the master
`SET` record is only written when `!isWebinCLI`
(`ST/uk/ac/ebi/embl/api/validation/check/file/MasterEntryValidationCheck.java:57-65`).
`assignProteinAccessionAndWriteToFile` (`FileValidationCheck.java:773-785`) only calls
`EmblEntryWriter` directly for `Context.sequence`.

What webin-cli actually *ships* is the **original, unmodified** files plus an ANALYSIS XML:
`WC/uk/ac/ebi/ena/webin/cli/context/genome/GenomeXmlWriter.java:58-111` lists
`chromosome_list`, `unlocalised_list`, `fasta`, `flatfile` by their original paths + MD5, and
`:29-56` writes the manifest metadata into `<SEQUENCE_ASSEMBLY>` (`NAME`, `TYPE`, `PARTIAL`,
`COVERAGE`, `PROGRAM`, `PLATFORM`, `MIN_GAP_LENGTH`, `MOL_TYPE`, `TPA`, `AUTHORS`, `ADDRESS`);
`WC/uk/ac/ebi/ena/webin/cli/context/SequenceToolsXmlWriter.java:60-74` adds `TITLE`,
`DESCRIPTION`, `STUDY_REF`, `SAMPLE_REF`.

The published record is therefore produced by the **ENA-internal pipeline** running the *same*
sequencetools library with `isWebinCLI = false`, i.e. the ERAPRO branch
(`ST/uk/ac/ebi/embl/api/validation/dao/EraproDAOUtilsImpl.java`), reading that ANALYSIS XML back
out of the database. So: the *logic* below is visible; the *execution* that produced OZ222062 was
server-side. Both branches are in these sources, which is why the map can still be complete — but
the accession, SV, DT lines and the release machinery are genuinely not here.

---

## 1. ID line: `ID   OZ222062; SV 1; linear; genomic RNA; STD; VRL; 18875 BP.`

Writer: `ST/uk/ac/ebi/embl/flatfile/writer/embl/IDWriter.java:27-121`. Token by token:

| Token | Writer | Ultimate source | Proof |
|---|---|---|---|
| `OZ222062` (accession) | `IDWriter.java:32-38` (`entry.getPrimaryAccession()`, else literal `XXX`) | **Server-side only.** Locally it is the first token of the submitter's own ID line. | `ST/uk/ac/ebi/embl/flatfile/reader/embl/IDReader.java:92-100`. Nothing in sequencetools calls `entry.setPrimaryAccession()` for a genome entry — the only non-reader caller is `EraproDAOUtilsImpl.java:467`, and that sets the *master* accession to the **analysis id**. See §2. |
| `SV 1` | `IDWriter.java:40-58` → `entry.getSequence().getVersion()` | **Server-side only** for genome. Locally only ever set by the reader from the submitter's own `SV`. | `IDReader.java:101-104`. `setVersion(1)` exists only for transcriptome (`FileValidationCheck.java:386`) and the `-context sequence` template path (`FileValidationCheck.java:616`). `rg "setVersion\("` over `ST/` shows no genome-context setter. |
| `linear` / `circular` | `IDWriter.java:60-72` → `Sequence.Topology` | **Chromosome list `CHROMOSOME_TYPE` column**, prefix before a `-`; else the submitter's ID line; else master default `LINEAR`. | Reader: `ST/uk/ac/ebi/embl/flatfile/reader/genomeassembly/ChromosomeListFileReader.java:89-96` splits `fields[2]` on `-`; if two parts, part 0 → `SequenceEntryUtils.getTopology()` (`ST/uk/ac/ebi/embl/api/validation/SequenceEntryUtils.java:643-655`). Applied per entry: `FileValidationCheck.java:402-409` (`getTopology`) and `:888-901` (`checkChromosomeTopology` — **hard error** if the ID-line topology and the chromosome list disagree), called from `FlatfileFileValidationCheck.java:116`. Fallback to master: `FileValidationCheck.java:366-368`; master default `LINEAR`: `ST/uk/ac/ebi/embl/api/service/MasterEntryService.java:156-157` (webin-cli) / `EraproDAOUtilsImpl.java:524` (server). Also `AssemblyTopologyFix.java:41-42` forces `LINEAR` in some scopes. |
| `genomic RNA` (mol type) | `IDWriter.java:74-86` → `entry.getSequence().getMoleculeType()` | **Manifest `MOLECULETYPE`**, via the master entry — *unconditionally overwriting* whatever the submitter's ID line said. | Manifest field + default: `WC/.../genome/GenomeManifestReader.java:48`, `:81` (`MOLECULE_TYPE_DEFAULT = "genomic DNA"`), `:87-88` (CV = `genomic DNA`, `genomic RNA`, `viral cRNA`), `:338-341`. → `ST/uk/ac/ebi/embl/api/validation/submission/SubmissionValidator.java:304` (`assemblyInfo.setMoleculeType`). → master: `MasterEntryService.java:151-155`. → copied over every entry: **`FileValidationCheck.java:365`** (note: no null guard — the submitter's value is always replaced). **Server-side caveat:** in the ERAPRO branch the manifest `MOL_TYPE` is honoured *only for viruses* — `EraproDAOUtilsImpl.java:568-570`: `if (molType != null && taxonClient.isChildOf(sample.getOrganism(), "Viruses"))`, otherwise it stays `genomic DNA` (`:519-522`). Ebolavirus is a virus, hence `genomic RNA`. |
| `STD` (dataclass) | `IDWriter.java:88-94` → `entry.getDataClass()` | **Computed** from context + file type + validation scope; `STD` ⇔ the entry name appears in the chromosome list. | `FileValidationCheck.java:362` calls `getDataclass(...)`, defined at `FileValidationCheck.java:250-303`: for `genome` + `EMBL` file type, `ASSEMBLY_CHROMOSOME → Entry.STD_DATACLASS`, `ASSEMBLY_CONTIG → Entry.WGS_DATACLASS` (`:272-283`); `AGP → CON`, `MASTER → SET`. Scope itself: `FileValidationCheck.java:134-164` — name in `chromosomeNameQualifiers` ⇒ `ASSEMBLY_CHROMOSOME`; in an AGP ⇒ `ASSEMBLY_SCAFFOLD`; else `ASSEMBLY_CONTIG`. Constants: `ST/uk/ac/ebi/embl/api/entry/Entry.java:63-77`. Also `DataclassFix.java:64-133` can re-derive dataclass from keywords/accession. |
| `VRL` (division) | `IDWriter.java:96-102` → `entry.getDivision()` | **ENA taxonomy service**, keyed on the source feature's taxId — *not* the manifest, *not* the submitter's ID line. | `ST/uk/ac/ebi/embl/api/validation/fixer/entry/DivisionFix.java:84-96`: `new TaxonomyClient().getTaxonByTaxid(taxId).getDivision()`; fallback by scientific name at `:98-110`; `"XXX"` if nothing found (`:74`). Overrides special-cases first: transgenic → `TGN`, `/environmental_sample` → `ENV` (`:49-56`). `shouldSetDivision` (`:125-135`) **overwrites even a non-empty division** for every non-NCBI scope. Registered in the fixer plan at `ST/uk/ac/ebi/embl/api/validation/plan/ValidationUnit.java:170`. Master's division is copied down at `FileValidationCheck.java:355`. The `Taxon.division` field and the REST endpoint are in the shipped SDK: `javap` of `webin-taxonomy-sdk-1.2.0.jar` → `uk.ac.ebi.ena.taxonomy.taxon.Taxon.getDivision()`; `TaxonomyClient$TaxonomyUrl` constant `https://www.ebi.ac.uk/ena/taxonomy/rest/%s/%s` with paths `tax-id`, `scientific-name`, `any-name`, `common-name`, `suggest-for-submission`. |
| `18875 BP` | `IDWriter.java:104-120` → `entry.getSequence().getLength()` | **Computed from the sequence bytes.** | Set by `ST/uk/ac/ebi/embl/flatfile/reader/SequenceReader.java:82-84`. The submitter's ID-line length goes to a *separate* field `idLineSequenceLength` (`IDReader.java:114-117`) that is only consulted for master/SET/annotation-only CON entries (`IDWriter.java:107-113`). |

---

## 2. AC line / accession assignment

* **webin-cli assigns no nucleotide accession.** Across `ST/`, `setPrimaryAccession` is called only
  from flat-file/GenBank readers (`IDReader.java:94,97`, `ACReader.java:57`,
  `genbank/AccessionReader.java:37`, `genbank/VersionReader.java:55,71`) and from
  `EraproDAOUtilsImpl.java:467`, which sets the **master** entry's accession to the *analysis id*,
  not a real accession.
* The only accession minting in the whole library is for **proteins**, and it is explicitly
  disabled for webin-cli: `FileValidationCheck.java:985-1010` — `if (isRemote.get()) return;` with
  the comment `// isRemote == isWebinCLI`; the real path calls
  `EntryDAOUtilsImpl.getNewProteinId()` against the ENAPRO DB.
* What the entry is called locally is the **entry name / submitter accession**:
  - flat file: first token of the `ID` line, promoted in
    `ST/uk/ac/ebi/embl/flatfile/reader/embl/EmblEntryReader.java:92-97`
    (`if ASSEMBLY_FILE_FORMAT && submitterAccession == null → setSubmitterAccession(primaryAccession)`),
    or from an `AC *` line (`ST/uk/ac/ebi/embl/flatfile/reader/embl/ACStarReader.java:46`).
    It is **mandatory**: `FlatfileFileValidationCheck.java:93-97` errors `EntryNameRequired`.
  - normalised by `SubmitterAccessionFix.fix(String)`
    (`ST/uk/ac/ebi/embl/api/validation/fixer/entry/SubmitterAccessionFix.java:58-74`: strip
    whitespace/`'`/`"`, map `\ / ; , |` → `_`, strip and coalesce `_`), called from
    `EmblEntryReader.java:98`. The chromosome-list `OBJECT_NAME` goes through the same fix
    (`ChromosomeListFileReader.java:79`), which is what makes the join work.
  - length limit 50 (`SubmitterAccessionCheck.java:24`); over-length is an **error** under
    webin-cli and a silent truncate+uniquify server-side (`:44-58`).
  - if absent in a non-master scope, synthesised as `contig<N>`/`scaffold<N>`/`chromosome<N>`
    (`AssemblyLevelEntryNameFix.java:45-57`).
  - it is echoed into the record as `AC * _<name>` (`ST/uk/ac/ebi/embl/flatfile/writer/embl/ACStarWriter.java:26-45`)
    and as `/submitter_seqid` (see §9).
* **Where OZ222062 comes from: not in these sources.** The receipt webin-cli parses returns only the
  ANALYSIS accession (`ERZ…`): `WC/uk/ac/ebi/ena/webin/cli/service/SubmitService.java:188-200`
  reads a single `accession` attribute per submitted XML type. The `OZ` form matches the generic
  2-letter + 6-digit ENA nucleotide pattern in `ST/uk/ac/ebi/embl/api/AccessionMatcher.java:29`
  (`^([A-Z]{1,2})([0-9]{5,6})$`), but **nothing in either tree allocates one**. Honest boundary:
  accession *and* `SV` are assigned by the ENA loader/ERAPRO, invisible here.

---

## 3. DE line: `DE   Sudan ebolavirus genome assembly, segment: main`

Two-stage template. Writer: `ST/uk/ac/ebi/embl/flatfile/writer/embl/DEWriter.java:31-41`
(falls back to a literal `.` if the description is blank).

**Stage 1 — master description** (`ST/uk/ac/ebi/embl/api/validation/SequenceEntryUtils.java:607-641`):

```java
String descriptionFormat = "%s %s %s genome assembly";          // :625
if (isTpa) descriptionFormat = "TPA: %s %s %s genome assembly"; // :626-628
...
return includeStrain  ? String.format(fmt, scientificName, "strain",  strainValue)   // :636-637
     : includeIsolate ? String.format(fmt, scientificName, "isolate", isolateValue)  // :638-639
     : String.format(fmt, scientificName, "", "").replaceAll("  ", "");              // :640
```

`scientificName` is the **sample organism** (`source.getScientificName()`, `:611`); `/strain` and
`/isolate` come from the source feature and are skipped when already contained in the organism
name (`:616-623`). With neither, the double-space collapse yields exactly
`"Sudan ebolavirus genome assembly"`. Called from `MasterEntryService.java:165-169` (webin-cli
branch) and `EraproDAOUtilsImpl.java:605-608` (server branch).

**Stage 2 — per-entry suffix** (`FileValidationCheck.java:369-384` → `Utils.setAssemblyLevelDescription`,
`ST/uk/ac/ebi/embl/api/validation/helper/Utils.java:1033-1051`). The assembly level is derived from
the validation scope: contig→0, scaffold→1, chromosome→2. For level 2 it calls
`Utils.getChromosomeDescription` (`Utils.java:1061-1098`), a first-match-wins ladder over the
**source feature's chromosome qualifiers**:

| Qualifier present | Suffix | Line |
|---|---|---|
| `/plasmid` | `, plasmid: <v>` | `Utils.java:1070-1071` |
| `/chromosome` | `, chromosome: <v>` | `:1072-1073` |
| `/organelle` | `, organelle: <v>` | `:1074-1075` |
| `/macronuclear` | `, organelle: macronuclear` | `:1076-1078` |
| **`/segment`** | **`, segment: <v>`** | **`:1079-1080`** |
| `/note="monopartite"` | `, complete genome: monopartite` | `:1081-1092` |
| else | `, <submitterAccession>` | `:1093, :1095` |

(contig/scaffold levels instead get `, contig: <name>` / `, scaffold: <name>` — `Utils.java:1053-1059`.)

So `segment: main` is the **`/segment` qualifier**, whose value is the chromosome list's
`CHROMOSOME_NAME` column — see §7. It is *not* read from the submitter's own `/segment` (their
source qualifiers were skipped, §0a) and not from their `DE` (skipped too).

**Manifest `DESCRIPTION` → `CC`, confirmed.** `WC/.../GenomeManifestReader.java:43,65,138-140,335`
reads it; `WC/.../SequenceToolsXmlWriter.java:62-63` writes it as
`/ANALYSIS_SET/ANALYSIS/DESCRIPTION`; server-side `EraproDAOUtilsImpl.java:502` selects exactly
that XPath and `:576-579` does `masterEntry.setComment(new Text(desc))`; it is reflowed to EMBL
width by `MasterEntryService.formatComment` (`:102-120`) and copied onto every entry at
`FileValidationCheck.java:354`, emitted by `ST/uk/ac/ebi/embl/flatfile/writer/embl/CCWriter.java`
(invoked at `EmblEntryWriter.java:95-97`). It never touches `DE`.
*Gap:* the webin-cli branch `MasterEntryService.getMasterEntryFromWebinCli` (`:122-184`) sets **no**
comment — the CC only materialises on the server round-trip.

---

## 4. OS / OC lines

Both come from the `Taxon` object hanging off the source feature's `/organism` qualifier, i.e. from
the **ENA taxonomy REST service**, keyed on the **ENA/BioSample sample's** taxId.

* Writers: `ST/uk/ac/ebi/embl/flatfile/writer/embl/EmblOrganismWriter.java:30-36` emits
  `OSWriter` + `OCWriter` + `OGWriter`; driven from `EmblEntryWriter.java:74-88`, which shows each
  distinct `taxon.getScientificName()` once.
* **OS**: `ST/uk/ac/ebi/embl/flatfile/writer/embl/OSWriter.java:34-48` — `taxon.getScientificName()`,
  plus ` (commonName)` when present; falls back to `sourceFeature.getScientificName()`.
* **OC**: `ST/uk/ac/ebi/embl/flatfile/writer/embl/OCWriter.java:34-53` — joins
  `taxon.getFamilyNames()` with `"; "`, terminated `"."`; guarded on
  `taxon.getLineage() != null`; if absent it writes the literal `unclassified sequences.`.
  `getLineage()`/`getFamilyNames()` are on the SDK `Taxon` (verified by `javap`).
* Where the `Taxon` is attached:
  `ST/uk/ac/ebi/embl/api/validation/helper/SourceFeatureUtils.java:245-252`
  (`setSourceFeatureTaxon`: `taxonomyClient.getTaxonByTaxid(sample.getTaxId())` →
  `sourceFeature.setTaxon(taxon)`), reached from `constructSourceFeature` (`:110-118`) via
  `addQualifiers` (`:160-188`). taxId resolution order (sample taxId, else lookup by organism name):
  `:137-149`. `SourceFeature.setTaxon` stores it inside the `OrganismQualifier`
  (`ST/uk/ac/ebi/embl/api/entry/feature/SourceFeature.java:46-57`;
  `ST/uk/ac/ebi/embl/api/entry/qualifier/OrganismQualifier.java:31-43` — `getValue()` *is*
  `taxon.getScientificName()`).
* The whole source feature is built from the **sample**, once, for the master entry:
  `SubmissionValidator.java:141-152` (`new SourceFeatureUtils().constructSourceFeature(manifest.getSample(), new TaxonomyClient())`
  plus an explicit `db_xref = <taxId>`), and is then copied onto every entry
  (`FileValidationCheck.java:601-605`).

---

## 5. RN / RA / RT / RL — the submitter reference

`ST/uk/ac/ebi/embl/api/validation/helper/ReferenceUtils.java` has **two** constructors, and which
one runs is exactly the webin-cli vs pipeline split.

**(a) From the manifest — `getSubmitterReferenceFromManifest` (`ReferenceUtils.java:33-52`)**

```java
Publication publication = getPublication(address, date);            // :36
if (doAddAuthorsToConsortium(submissionAccountId)) publication.setConsortium(authors);  // :37-38
else publication.addAuthors(getAuthors(authors));                   // :40-44
ref.setAuthorExists(true); ref.setLocationExists(true); ref.setReferenceNumber(1);      // :48-50
```

* `getPublication` (`:54-61`) creates a `Submission` publication → `RL   Submitted (DD-MON-YYYY) to
  the INSDC. <address>`; the date defaults to **now** if null (`:56`).
* `getAuthors` (`:63-75`) splits the `AUTHORS` string on `,` and parses each through
  `EmblPersonMatchHelper`, i.e. surname/initials.
* Special case `:77-79`: `doAddAuthorsToConsortium` is `true` **only for `Webin-55551`**, where the
  authors string is put in `RG` (consortium) instead of `RA`. Hard-coded.
* Inputs are `assemblyInfoEntry.getAuthors()/getAddress()/getDate()/getSubmissionAccountId()` —
  and those are **the manifest `AUTHORS` / `ADDRESS` fields**:
  `WC/.../GenomeManifestReader.java:55-56, 77-78, 211-219, 323-332` (both-or-neither; supplying one
  raises `MANIFEST_READER_MISSING_ADDRESS_OR_AUTHOR_ERROR`), passed to
  `SubmissionValidator.java:133-135` (`assemblyInfo.setAuthors/.setAddress`).
  Note the manifest help text: *"For submission brokers only."*
* Applied to the master entry at `MasterEntryService.java:171-181`, **guarded**:
  `if (isNotBlank(address) && isNotBlank(authors))`. References are then copied onto every entry at
  `FileValidationCheck.java:349-351`.
* **If the manifest omits them, the webin-cli branch adds no reference at all** — there is no
  `else` at `MasterEntryService.java:181`. (The only local placeholder — a hard-coded author
  `CLELAND` at EMBL-EBI — is in `addTemplateHeader`, `FileValidationCheck.java:653-667`, which runs
  only for `Context.sequence`, and even there only when `isWebinCLI`.)

**(b) From the Webin account — `constructSubmitterReference` (`ReferenceUtils.java:81-129`)**

* Authors are built from `submitterReference.getSubmissionContacts()` (`:89-110`): surname is
  `WordUtils.capitalizeFully` + middle initials, first name via `getFirstName(...)`, all pushed
  through `Ascii7CharacterConverter`. A contact with a `consortium` value suppresses its personal
  name (`:93-95`, WAP-126) and all consortia are concatenated into `RG` (`:119-126`).
* `RL` address comes from `getAddressFromSubmissionAccount(...)` (`:112-113`, `:131-…`), which for a
  broker account concatenates the broker name (`:137-140`).
* **Only reachable server-side.** Its single caller is
  `EraproDAOUtilsImpl.getSubmitterReference` (`:140-155`), which fetches the submission account and
  its `submission_contact` rows from the ERAPRO DB. The class doc at `:135-138` says so explicitly:
  *"Used in pipelines to build <Reference> object if authors and address information is not
  available in analysis.xml"*.

**So: what happens when the manifest omits `AUTHORS`/`ADDRESS`?** Server-side,
`EraproDAOUtilsImpl.java:594-603`:

```java
if (isNotBlank(author)) {
   if (isBlank(address)) address = referenceUtils.getAddressFromSubmissionAccount(...);  // :592-595
   masterEntry.addReference(getSubmitterReferenceFromManifest(author, address, firstCreated, submissionAccountId));
} else {
   masterEntry.addReference(getSubmitterReference(analysisId));   // :601 → account contacts
}
```

i.e. **yes — ENA falls back to the Webin submission account's contacts, server-side**, and the `RL`
submission date is the analysis `first_created` (`:559`, `:596`), not a manifest field. Same logic
per-entry in `getReference` (`EraproDAOUtilsImpl.java:158-208`).

`RN [1]` is always `1` (`ReferenceUtils.java:50`, `:118`). `RT` for a `Submission` publication is
written as an empty title by `ST/uk/ac/ebi/embl/flatfile/writer/embl/RTWriter.java` /
`EmblSubmissionWriter.java` — neither branch ever sets a title.

---

## 6. KW (keywords)

Only two code paths add keywords anywhere in `ST/`:

1. **TPA** — `ST/uk/ac/ebi/embl/api/validation/helper/EntryUtils.java:243-247`:
   `"Third Party Data"`, `"TPA"`, `"TPA:assembly"`. Added to the **master entry only**, gated on
   `infoEntry.isTpa()` (`MasterEntryService.java:161-163`; server-side `EraproDAOUtilsImpl.java:563-566`)
   — i.e. manifest `TPA=yes` (`WC/.../GenomeManifestReader.java:50, 205-207, 352-354`).
2. **Dataclass mirroring** — `ST/uk/ac/ebi/embl/api/validation/fixer/entry/DataclassFix.java:33-40`
   (`enum DataclassKeywords`) and `:118-128`: adds a keyword equal to the dataclass, but **only for
   `WGS, EST, GSS, HTC, STS, TSA, TLS`**. `STD` is not in the enum, so `DataclassKeywords.getKeywords("STD")`
   throws and returns `null` (`:49-56`) and nothing is added. The reverse map (keyword → dataclass)
   lives in `STR/uk/ac/ebi/embl/api/validation/data/keyword_dataclass.tsv`.

**So for a chromosome-level `STD` genome entry with `TPA=no`, sequencetools generates no keywords
at all** — and the submitter's own `KW` line was skipped at parse time (§0a). Note
`ST/uk/ac/ebi/embl/flatfile/writer/embl/KWWriter.java:32-53` still always emits a line, sorting
keywords by *string length* (`:37-39`) and terminating with `"."`, so an empty keyword set prints
literally `KW   .`.
**Unverified:** if the live OZ222062 record carries non-trivial `KW` content, it does not come from
these two sources; a downstream loader/putff component (not in this tree) must add it.
A contig-level entry, by contrast, gets `KW   WGS.` from `DataclassFix`.

---

## 7. `/segment` and the chromosome list

**File format** — `ST/uk/ac/ebi/embl/flatfile/reader/genomeassembly/ChromosomeListFileReader.java`:
whitespace-separated (`:36` `Pattern.compile("\\s+")`), 3 or 4 columns (`:38-43`):

| Col | Index const | Handling |
|---|---|---|
| 1 | `OBJECT_NAME_COLUMN = 0` | `SubmitterAccessionFix.fix()` then trailing `;` stripped — `:79-80`, `:114-116`. Joins to the entry name. |
| 2 | `CHROMOSOME_NAME_COLUMN = 1` | `ChromosomeNameFix.fix()` — `:82-87` |
| 3 | `CHROMOSOME_TYPE_COLUMN = 2` | split on `-`; `<topology>-<type>` or bare `<type>` — `:89-96` |
| 4 | `CHROMOSOME_LOCATION_COLUMN = 3` | lower-cased — `:97-107` (optional) |

`ChromosomeNameFix` (`ST/uk/ac/ebi/embl/api/validation/fixer/entry/ChromosomeNameFix.java:17-52`)
removes whitespace, maps `\ / | = ;` → `_`, strips/coalesces `_`, then **deletes the words**
`chromosome, chrom, chrm, chr, linkage-group, linkage group, plasmid` case-insensitively, and maps
`mitocondria`/`mitochondria` → `MT`.

Allowed `CHROMOSOME_TYPE` values (case-insensitive, normalised to lowercase):
`chromosome, plasmid, monopartite, segmented, multipartite, linkage_group` —
`ST/uk/ac/ebi/embl/api/validation/check/genomeassembly/ChromosomeListChromosomeTypeCheck.java:32-42`.
Allowed `CHROMOSOME_LOCATION` values: `macronuclear, nucleomorph, mitochondrion, kinetoplast,
chloroplast, chromoplast, plastid, virion, phage, proviral, prophage, viroid, cyanelle, apicoplast,
leucoplast, proplastid, hydrogenosome, chromatophore` —
`.../ChromosomeListChromosomeLocationCheck.java:25-46`.

**Rows are loaded into a name→row map** keyed on upper-cased `OBJECT_NAME`:
`ST/uk/ac/ebi/embl/api/validation/check/file/ChromosomeListFileValidationCheck.java:65-68`
(`sharedInfo.chromosomeNameQualifiers`). That same map is what promotes an entry to
`ASSEMBLY_CHROMOSOME` scope and hence `STD` (§1).

**The mapping table** — `ST/uk/ac/ebi/embl/api/entry/genomeassembly/ChromosomeEntry.java:94-134`
(`setAndGetQualifiers(boolean virus)`):

| Condition | Qualifier emitted | Line |
|---|---|---|
| `CHROMOSOME_LOCATION` non-empty **AND `!virus`** AND location ≠ `Phage` | `/organelle = getOrganelleValue(location)` | `:102-113` |
| else if `CHROMOSOME_NAME` non-empty AND type == `plasmid` | `/plasmid = <name>` | `:115-118` |
| else if … type == `chromosome` | `/chromosome = <name>` | `:119-122` |
| else if … type == `segmented` **or** `multipartite` | **`/segment = <name>`** | `:123-127` |
| (independently) type == `monopartite` | `/note = "monopartite"` | `:129-132` |
| type == `linkage_group` | **nothing** (falls through — silent gap) | — |

`getOrganelleValue` is a fixed 13-entry table at
`ST/uk/ac/ebi/embl/api/validation/SequenceEntryUtils.java:51-69` (`plastid:chloroplast → chloroplast`, etc.).

The `virus` flag is computed live: `FileValidationCheck.java:578-584` calls
`taxonomyClient.isChildOf(masterEntry source /organism, "Viruses")`. **For a virus the
`CHROMOSOME_LOCATION` column is ignored and the name/type branch is used instead** — which is
exactly why *Sudan ebolavirus* with `CHROMOSOME_TYPE = segmented` (or `multipartite`) and
`CHROMOSOME_NAME = main` yields `/segment="main"`.

Qualifiers are attached in `FileValidationCheck.addSourceQualifiers` (`:538-609`), and note
`:565` — **`entry.getPrimarySourceFeature().removeAllQualifiers()`** immediately before: any source
qualifier that did survive parsing is wiped, then chromosome qualifiers (`:573-591`), then the
master's sample-derived qualifiers (`:601-605`), then `/submitter_seqid` (`:606-608`) are added.

---

## 8. `assembly_gap` features

**Scanner** — `ST/uk/ac/ebi/embl/api/validation/check/sequence/SequenceToGapFeatureBasesCheck.java:54-154`:
walks `sequence.getSequenceByte()` byte by byte looking for `'n'` (lower-case only — safe because
the reader lower-cases, §9), building `NRegion(start,end)` runs (`:84-119`), then for each run not
already matched *exactly* (both endpoints) by an existing `gap`/`assembly_gap` feature (`:121-149`)
calls `processMissingGapFeature`. It also errors if ≥100 % of the sequence is N (`:46`, `:107-109`).

**Generator** — `ST/uk/ac/ebi/embl/api/validation/fixer/sequence/SequenceToGapFeatureBasesFix.java:52-112`
(subclass overriding `processMissingGapFeature`):

* **Threshold** (`:55-62`):
  `ERROR_THRESHOLD = (options.minGapLength != 0) ? options.minGapLength - 1 : Entry.DEFAULT_MIN_GAP_LENGTH`
  and the feature is created only `if (nRegion.getLength() > ERROR_THRESHOLD)`.
  `Entry.DEFAULT_MIN_GAP_LENGTH = 10` (`ST/uk/ac/ebi/embl/api/entry/Entry.java:78`) ⇒ **default is
  runs of ≥ 11 N**; with an explicit `minGapLength = k` it is ≥ k.
* **Which feature**: `assembly_gap` when the scope is in `Group.ASSEMBLY` **or** the entry already
  has an `assembly_gap` (`:72-74`); otherwise a plain `gap` (`:93`). Genome context is always
  `Group.ASSEMBLY`, so **`assembly_gap`**.
* **Qualifiers set** (`:76-78`): `/estimated_length = <exact run length>` and
  **`/gap_type = "unknown"`**, hard-coded. **No `/linkage_evidence` is ever generated.**
* **Post-pass** (`:114-147`): if ≥ 90 % of the newly created gaps are exactly 100 bp
  (`GAP_ESTIMATED_LENGTH = 100`, `SequenceToGapFeatureBasesCheck.java:44`), every such
  `/estimated_length="100"` is rewritten to `"unknown"`.
* `ST/uk/ac/ebi/embl/api/validation/fixer/feature/Linkage_evidenceFix.java:40-53` then **removes**
  any `/linkage_evidence` whose sibling `/gap_type` is not one of `within scaffold`,
  `repeat within scaffold`, `contamination` — so a generated gap (`gap_type="unknown"`) can never
  carry linkage evidence. It also underscore→space normalises values (`:55-65`) and forces
  `unspecified` under `gap_type="contamination"` (`:66-69`).

**Does it run in the FLATFILE path?** Yes.
`ValidationUnit.SEQUENCE_ENTRY_FIXES` lists `SequenceToGapFeatureBasesFix.class` at
`ST/uk/ac/ebi/embl/api/validation/plan/ValidationUnit.java:212` (and the check at `:158`); the fix's
`@ExcludeScope` is only `{NCBI, ASSEMBLY_TRANSCRIPTOME}` (`SequenceToGapFeatureBasesFix.java:35`),
so all three assembly scopes run it. Fixes execute before checks in
`ST/uk/ac/ebi/embl/api/validation/plan/EmblEntryValidationPlan.java:47-55`, gated on
`options.isFixMode` which defaults to `true` (`SubmissionOptions.java:56`). The path is entered from
`FlatfileFileValidationCheck.java:118-121`. It is **not** FASTA/AGP-specific.

**Gap I must flag:** `SubmissionOptions.minGapLength` is **never assigned from the manifest**.
`rg "minGapLength"` over `ST/` returns only the field declaration
(`SubmissionOptions.java:63`, initialised `0`), the two readers of it, the unrelated
`AssemblyInfoEntry` setter, and `AssemblyInfoReader.java:71-74` (the legacy `assembly_info` file
format). `SubmissionValidator.setGenomeOptions` does `assemblyInfo.setMinGapLength(manifest.getMinGapLength())`
(`SubmissionValidator.java:306`) but never `options.minGapLength = …`. **Under webin-cli the
manifest `MINGAPLENGTH` therefore does not reach the gap threshold and the default 10 always
applies.** Server-side the value does reach the pipeline via `MIN_GAP_LENGTH` in the analysis XML
(`GenomeXmlWriter.java:43-44`) — but the code that consumes it is not in this tree.

Two related behaviours that keep a *leading* gap like `assembly_gap 1..104` alive:
`SequenceBasesFix` (which strips terminal Ns and shifts feature locations,
`ST/uk/ac/ebi/embl/api/validation/fixer/sequence/SequenceBasesFix.java:66-103`) is `@ExcludeScope`d
for `ASSEMBLY_CONTIG`, `ASSEMBLY_CHROMOSOME`, `ASSEMBLY_SCAFFOLD` (`:28-34`), and it only acts on
non-circular entries anyway. Submitter-supplied `assembly_gap` features *do* survive, since
non-source features are parsed normally.

---

## 9. Everything else that is generated

**Source-feature qualifiers re-synthesised at *write* time** —
`ST/uk/ac/ebi/embl/flatfile/writer/FeatureWriter.java:83-105`, doc comment: *"Adds organism,
/mol_type and /db_ref="taxon:" feature qualifiers into the source feature. If these qualifiers
already exist they are removed."*

* `/organism` ← `((SourceFeature)feature).getScientificName()` i.e. the `Taxon` (`:90-94`)
* `/mol_type` ← **`entry.getSequence().getMoleculeType()`** — the *ID-line* molecule type, not a
  stored qualifier (`:95-99`)
* `/db_xref="taxon:<id>"` ← `getTaxId()`, suppressed for negative ids (`:100-104`)
* the originals are then filtered out of the qualifier list: `/organism` `:113-115`, `/mol_type`
  `:116-118`, `/db_xref="taxon:…"` `:119-122`, `/sub_species` `:123-125`.
* Additional `/db_xref` entries are synthesised from the entry's `XRef` objects
  (`:133-149`) — e.g. `BioSample` (`MasterEntryService.java:160`).

**Other generated features/qualifiers**

* `/submitter_seqid = <entry name>` — added for all three assembly scopes when absent:
  `FileValidationCheck.java:867-886`, called at `FlatfileFileValidationCheck.java:120`.
  *(Not visible in the quoted OZ222062 excerpt; whether it survives to distribution is not
  determinable from these sources.)*
* `/note = "contig: <entry name>"` — added to WGS-dataclass entries: `FileValidationCheck.java:593-599`.
* `/isolate = <sample name>` — auto-added for **prokaryotes** lacking strain/isolate/environmental_sample:
  `SourceFeatureUtils.addExtraSourceQualifiers` (`:90-108`).
* `/geo_loc_name` — **synthesised** from two BioSample attributes:
  `"geographic location (country and/or sea)"` + `"geographic location (region and locality)"`
  joined with `":"` → `SourceFeatureUtils.java:189-203` (`categorizeQualifiers`) and `:205-217`
  (`setGeoLocationQualifier`). `"Uganda:Kampala"` is exactly this concatenation, from the **ENA
  sample record**, not the flat file. `GeoLocationQualifierFix` is `@ExcludeScope`d for every
  assembly scope (`.../fixer/sourcefeature/GeoLocationQualifierFix.java:26-47`), so no further
  rewriting happens.
* `/lat_lon` — synthesised from latitude/longitude attributes with N/S/E/W suffixes:
  `SourceFeatureUtils.java:224-243`.
* `/collection_date` — sample attribute `"collection date"` mapped through the synonym table
  (`SourceFeatureUtils.java:44-48`) and dropped if it fails `MasterSourceQualifierValidator`
  (`:64-69`). Only qualifiers in the `MASTERSOURCEQUALIFIERS` allow-list survive from the sample
  (`EraproDAOUtilsImpl.java:66-80`: `ecotype, cultivar, isolate, strain, sub_species, variety,
  sub_strain, cell_line, serotype, serovar, environmental_sample, metagenome_source,
  isolation_source, collection_date, geo_loc_name`), and values in
  `{not applicable, not collected, not provided, restricted access, missing}` are dropped
  (`:56-57`, `:98-101`).
* `source 1..<len>` — if the entry has **no** source feature at all, one spanning the whole
  sequence is fabricated: `FileValidationCheck.java:540-551`. If the submitter did supply a
  `source` line, its *location* is kept (only the qualifiers were skipped).

**Line-level output shaping** (`ST/uk/ac/ebi/embl/flatfile/writer/embl/EmblEntryWriter.java:47-132`)

* Fixed line order `ID, AC, AC *, PR, DT, DE, KW, OS/OC/OG, R*, DR, CC, AS, FT, CO, master lines, SQ, //`,
  with `XX` separators between blocks (`:44`, `:51-128`).
* **Features are re-sorted**: `FTWriter.java:50-63` sorts by `Feature.compareTo`
  (`ST/uk/ac/ebi/embl/api/entry/feature/Feature.java:293-330`: source first, then by min position,
  then longest-first), default on (`ST/uk/ac/ebi/embl/flatfile/writer/EntryWriter.java:24`).
* **Qualifiers are re-sorted** into INSDC canonical order: `FeatureWriter.java:150-152` →
  `Qualifier.compareTo` (`ST/uk/ac/ebi/embl/api/entry/qualifier/Qualifier.java:229-246`) using the
  `FORDER` column of `STR/uk/ac/ebi/embl/api/validation/data/feature-qualifier-values.tsv`:
  `organism=1, organelle=4, plasmid=5, chromosome=6, segment=8, isolate=17, mol_type=20,
  geo_loc_name=21, collection_date=26, estimated_length=83, note=85, db_xref=86, gap_type=104,
  linkage_evidence=105, submitter_seqid=110`. This reproduces the published ordering
  (`/organism, /segment, /mol_type, /geo_loc_name, /collection_date, /db_xref`) exactly.
* **`SQ` header is recomputed**: A/C/G/T/other counts tallied at write time, plus an optional
  `CRC32` — `ST/uk/ac/ebi/embl/flatfile/writer/embl/EmblSequenceWriter.java:43-96`.
* **Sequence body reformatted**: 10-base blocks, 6 blocks (60 bases) per line, right-aligned running
  base count — `EmblSequenceWriter.java:98-141`.
* **Sequence bases are rewritten on *read***: `ST/uk/ac/ebi/embl/flatfile/reader/SequenceReader.java:93-110`
  is a translation table that lower-cases every IUPAC base, **maps `U`/`u` → `t`**, and substitutes
  spaces and digits away. So a submitted RNA sequence is stored (and re-emitted) as `t`, and case is
  always lost.
* `CO` line: only when `entry.hasContigs()` — `ST/uk/ac/ebi/embl/flatfile/writer/embl/COWriter.java:31-49`
  (AGP/CON path; not the plain-FLATFILE path). `AgptoConFix.java:67` is what sets `CON` dataclass.
* **`ST *` lines: never written.** `EmblPadding.ST_STAR_PADDING` / `EmblTag.ST_STAR_TAG` exist
  (`ST/uk/ac/ebi/embl/flatfile/EmblPadding.java:43`, `EmblTag.java:46`) and there is an
  `STStarReader`, but there is **no `STWriter` in `ST/uk/ac/ebi/embl/flatfile/writer/embl/`** and
  `EmblEntryWriter.write` never emits one. Whatever `ST *` appears in ENA-internal files is written
  by another component.
* **`DT` lines: server-side only.** `ST/uk/ac/ebi/embl/flatfile/writer/embl/DTWriter.java:33-38`
  requires `firstPublic`, `firstPublicRelease`, `lastUpdated`, `lastUpdatedRelease`, `version`; and
  `rg "setFirstPublic|setLastUpdated|setLastUpdatedRelease"` over `ST/` finds **only**
  `Entry.java` accessors and the flat-file readers (`DTReader.java:83-102`,
  `genbank/LocusReader.java:110`). Since the `DT` tag is skipped in `ASSEMBLY_FILE_FORMAT`, no
  webin-cli/sequencetools path can ever populate them. The release numbers in particular come from
  the ENA production database.
* Master-only lines `WGS`/`TLS`/`TSA`/`CON` ranges: `EmblEntryWriter.java:113-125`
  (`MasterWGSWriter`, `MasterTLSWriter`, `MasterTSAWriter`, `MasterCONWriter`) — only on the `SET`
  master record, which webin-cli does not write (§0b).

---

## Summary map

| Output element | Ultimate source | Key proof |
|---|---|---|
| `ID` accession | **server-side only** (ENA loader) | `IDWriter.java:32-38`; no genome-path `setPrimaryAccession` in `ST/` |
| `ID` `SV` | **server-side only** for genome | `IDWriter.java:40-58`; `IDReader.java:101-104`; no genome `setVersion` |
| `ID` topology | chromosome list `CHROMOSOME_TYPE` prefix → else submitter ID line → else `LINEAR` | `ChromosomeListFileReader.java:89-96`; `FileValidationCheck.java:402-409, 888-901, 366-368`; `MasterEntryService.java:156-157` |
| `ID` molecule type | manifest `MOLECULETYPE` (server-side: virus-only) | `GenomeManifestReader.java:338-341`; `MasterEntryService.java:151-155`; `FileValidationCheck.java:365`; `EraproDAOUtilsImpl.java:568-570` |
| `ID` dataclass `STD` | computed: entry name ∈ chromosome list | `FileValidationCheck.java:250-303`, `:134-164`, `:362` |
| `ID` division `VRL` | **ENA taxonomy service** by taxId | `DivisionFix.java:84-96`; `ValidationUnit.java:170` |
| `ID` length | computed from sequence bytes | `IDWriter.java:104-120`; `SequenceReader.java:82-84` |
| `AC` | **server-side only** | §2 |
| `AC *` | entry name (ID-line token, normalised) | `ACStarWriter.java:26-45`; `EmblEntryReader.java:92-98` |
| `DE` stem | template + **sample organism** (+/strain,/isolate) | `SequenceEntryUtils.java:607-641` |
| `DE` `, segment: main` | `/segment` ← chromosome list `CHROMOSOME_NAME` | `Utils.java:1079-1080`; `ChromosomeEntry.java:123-127` |
| `CC` | manifest `DESCRIPTION` (via analysis XML, server round-trip) | `SequenceToolsXmlWriter.java:62-63`; `EraproDAOUtilsImpl.java:502, 576-579`; `FileValidationCheck.java:354` |
| `KW` | TPA flag, or dataclass mirror (never for `STD`) | `EntryUtils.java:243-247`; `DataclassFix.java:33-40, 118-128` |
| `OS` | taxonomy service scientific/common name | `OSWriter.java:34-48`; `SourceFeatureUtils.java:245-252` |
| `OC` | taxonomy service lineage | `OCWriter.java:34-53` |
| `RN/RA/RL` | manifest `AUTHORS`+`ADDRESS`; **else Webin account contacts, server-side** | `ReferenceUtils.java:33-52` vs `:81-129`; `EraproDAOUtilsImpl.java:594-603` |
| `/organism`, `/mol_type`, `/db_xref="taxon:"` | re-synthesised at write time | `FeatureWriter.java:83-105` |
| `/segment` `/chromosome` `/plasmid` `/organelle` `/note=monopartite` | chromosome list row (+ virus flag) | `ChromosomeEntry.java:94-134`; `FileValidationCheck.java:573-591` |
| `/geo_loc_name`, `/collection_date`, `/lat_lon`, `/isolation_source`, `/strain`… | **ENA SAMPLE / BioSample attributes** | `SourceFeatureUtils.java:160-243`; allow-list `EraproDAOUtilsImpl.java:66-80` |
| `/submitter_seqid`, `/note="contig: …"` | entry name | `FileValidationCheck.java:867-886`, `:593-599` |
| `assembly_gap` + `/estimated_length` + `/gap_type="unknown"` | computed from runs of N (> 10 by default) | `SequenceToGapFeatureBasesCheck.java:54-154`; `SequenceToGapFeatureBasesFix.java:52-112` |
| `/linkage_evidence` | never generated; pruned unless gap_type allows | `Linkage_evidenceFix.java:40-53` |
| `SQ` counts, 60-col layout, lower-case, `U→t` | computed | `EmblSequenceWriter.java:43-141`; `SequenceReader.java:93-110` |
| feature + qualifier ordering | canonical re-sort | `Feature.java:293-330`; `Qualifier.java:229-246` + `feature-qualifier-values.tsv` |
| `DT` | **server-side only** (production DB) | `DTWriter.java:33-38`; no setters outside readers |
| `ST *` | not written by this library at all | no `STWriter` under `.../writer/embl/` |

## Things I could NOT verify statically

1. **Accession (`OZ222062`) and `SV`** — allocated outside both trees. Nothing here mints them.
2. **`DT` dates and release numbers** — likewise.
3. **`KW` content of the live record** — sequencetools generates none for a `STD` genome entry;
   if the real record has keywords, the source is a component not in these trees.
4. **Whether `/submitter_seqid` and `AC *` survive to the public record** — they are generated, but
   the distribution-time filtering is server-side.
5. **Whether `MIN_GAP_LENGTH` from the analysis XML reaches the server-side gap threshold** — the
   XML carries it (`GenomeXmlWriter.java:43-44`) but no consumer exists in these sources; under
   webin-cli it is definitively unused (see §8).
6. **The exact chromosome-list row used for OZ222062** — I infer `CHROMOSOME_TYPE ∈ {segmented,
   multipartite}` and `CHROMOSOME_NAME = main` from the `/segment="main"` output; the file itself is
   not on disk here.
7. Whether the live record was produced by the ERAPRO branch rather than some third code path — the
   webin-cli branch provably writes no record (§0b) and the ERAPRO branch reproduces every observed
   field, which is strong but circumstantial.
