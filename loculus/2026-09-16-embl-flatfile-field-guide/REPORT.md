# Where every part of a Pathoplexus record on ENA comes from

2026-09-16. A field-by-field map of the EMBL flat file that ENA publishes for a Pathoplexus
submission: what each line is, what it looks like in practice, which of our inputs produced it,
and what we could put in that we currently don't.

Worked against a real published record, `OZ222062.1` (Pathoplexus `PP_0011CQ4.2`, Sudan
ebolavirus, submitted Feb 2025), and the current code in `ena-submission/` and
`preprocessing/nextclade/`.

---

## 1. The thing to know first: we don't submit the flat file that gets published

We upload a flat file, but ENA does not publish it. In `-context genome`, ENA parses our file,
**throws away its header and its entire `source` feature**, and rebuilds the record from four other
things we submitted separately. Our flat file survives as three things only: the **sequence**, the
**entry name**, and — once PR #4503 lands — the **annotation** (`gene`/`CDS` features).

So "how do we change field X on ENA" almost never has the answer "edit the flat file".

### What we actually upload

| Artifact | Built by | Real example | What it ends up controlling |
|---|---|---|---|
| **BioProject** | `create_project.py` | `PRJEB85569` | the `PR` line |
| **BioSample** | `create_sample.py` + `config/defaults.yaml` → `metadata_mapping` | `SAMEA117658922`, taxon 186540, 18 attributes | **the entire `source` feature**, `OS`/`OC`, `DR BioSample` |
| **`manifest.tsv`** | `create_manifest` in `ena_submission_helper.py` | `MOLECULETYPE genomic RNA`, `DESCRIPTION Original sequence submitted to Pathoplexus with accession: PP_0011CQ4, version: 2` | `ID` mol_type, `CC`, `RN`/`RA`/`RL` |
| **`chromosome_list.gz`** | `create_chromosome_list_object` | `PP_0011CQ4<TAB>main<TAB>linear-monopartite` | `/segment`, topology, the `DE` suffix |
| **`sequences.embl.gz`** | `create_flatfile` | see below | sequence + entry name (+ annotation, pending) |

### What our flat file looks like today

From the repo's own fixture (`ena-submission/test/data/test_flatfile_with_apostrophe.embl`):

```
ID   LOC_TEST001; ; linear; RNA; ; UNC; 12 BP.
XX
AC   LOC_TEST001;
XX
DE   Original sequence submitted to Loculus with accession: LOC_TEST001, version: 1
XX
OS   Test scientific name
OC   .
XX
RN   [1]
RA   Malago' G., O'Brien P.;
XX
FH   Key             Location/Qualifiers
FH
FT   source          1..12
FT                   /molecule_type="genomic RNA"
FT                   /organism="Test scientific name"
FT                   /country="Italy"
FT                   /collection_date="2024-01-01"
XX
SQ
     atcgatcgat cg                                                            12
//
```

Of that, ENA keeps `LOC_TEST001` (the entry name) and the bases. Everything else is discarded and
regenerated.

### What ENA publishes

```
ID   OZ222062; SV 1; linear; genomic RNA; STD; VRL; 18875 BP.
XX
AC   OZ222062;
XX
PR   Project:PRJEB85569;
XX
DT   05-FEB-2025 (Rel. 144, Created)
DT   06-FEB-2025 (Rel. 144, Last updated, Version 1)
XX
DE   Sudan ebolavirus genome assembly, segment: main
XX
KW   .
XX
OS   Sudan ebolavirus
OC   Viruses; Riboviria; Orthornavirae; Negarnaviricota; Haploviricotina;
OC   Monjiviricetes; Mononegavirales; Filoviridae; Orthoebolavirus;
OC   Orthoebolavirus sudanense.
XX
RN   [1]
RA   Nabadda S., Sewanyana I., Kyobe Bosa H., ... Ayitewala A.;
RT   ;
RL   Submitted (04-FEB-2025) to the INSDC.
RL   The Central Public Health Laboratories, Kampala, , Uganda
XX
DR   MD5; 41ca00105451076bebe1c7fce9974248.
DR   BioSample; SAMEA117658922.
XX
CC   Original sequence submitted to Pathoplexus with accession: PP_0011CQ4,
CC   version: 2
XX
FH   Key             Location/Qualifiers
FH
FT   source          1..18875
FT                   /organism="Sudan ebolavirus"
FT                   /segment="main"
FT                   /mol_type="genomic RNA"
FT                   /geo_loc_name="Uganda:Kampala"
FT                   /collection_date="2025-01-19"
FT                   /db_xref="taxon:186540"
FT   assembly_gap    1..104
FT                   /estimated_length=104
FT                   /gap_type="unknown"
FT   assembly_gap    18330..18875
FT                   /estimated_length=546
FT                   /gap_type="unknown"
XX
SQ   Sequence 18875 BP; 5669 A; 3944 C; 3648 G; 4964 T; 650 other;
     nnnnnnnnnn nnnnnnnnnn ...
//
```

---

## 2. Line-by-line map

EMBL flat files use two-letter line codes. `XX` is just a blank separator and `//` ends the record;
neither carries information.

| Line | What it is | Example on `OZ222062` | Where the value comes from | Our lever |
|---|---|---|---|---|
| `ID` field 1 | The INSDC accession | `OZ222062` | ENA's loader assigns it at publication | **none** |
| `ID` `SV` | Sequence version, bumped when the bases change | `SV 1` | ENA | **none** |
| `ID` field 3 | Topology — linear or circular molecule | `linear` | `chromosome_list.gz` column 3, the part before the `-` | `enaOrganisms[org].topology` (Helm config) |
| `ID` field 4 | Molecule type | `genomic RNA` | manifest `MOLECULETYPE`; overwrites whatever our `ID` line said | `enaOrganisms[org].molecule_type` |
| `ID` field 5 | Data class — how finished the record is. `STD` = standard finished sequence, `WGS` = shotgun contig | `STD` | Computed: our entry name appears in the chromosome list, so `STD` | indirect only |
| `ID` field 6 | Taxonomic division — a 3-letter bucket. `VRL` = viral, `PRO` = prokaryote, `ENV` = environmental | `VRL` | ENA taxonomy service, looked up from the **BioSample's** taxId | **none** (follows the taxon) |
| `ID` field 7 | Sequence length | `18875 BP` | Counted from our bases | our sequence |
| `AC` | Accession line, repeats the ID accession | `OZ222062;` | ENA | **none** |
| `PR` | Linked BioProject (umbrella grouping for a submission set) | `Project:PRJEB85569;` | manifest `STUDY` | our BioProject |
| `DT` | Creation and last-update dates, with the EMBL release number | `05-FEB-2025 (Rel. 144, Created)` | ENA | **none** |
| `DE` | Free-text description — the title you see in search results | `Sudan ebolavirus genome assembly, segment: main` | Template: `"{BioSample organism} genome assembly"` + `", segment: {chromosome_list column 2}"`. Our `DE` is ignored | organism name (BioSample) + segment name (chromosome list) |
| `KW` | Keywords | `.` (empty) | Only ever filled for TPA submissions or WGS/TSA data classes; an `STD` record can't have any | **none** |
| `OS` | Organism scientific name | `Sudan ebolavirus` | ENA taxonomy service, from the BioSample taxId | `taxon_id` in the organism config |
| `OC` | Full taxonomic lineage | `Viruses; Riboviria; ... Orthoebolavirus sudanense.` | Same taxonomy lookup | same |
| `RN` | Reference number | `[1]` | Always `1` | **none** |
| `RA` | Reference authors | `Nabadda S., Sewanyana I., ...` | manifest `AUTHORS` (broker-only field), reformatted from `Surname, Given` to `Surname I.` | the `authors` Loculus field |
| `RT` | Reference title | `;` (empty) | Never set for a submission-type reference | **none** |
| `RL` | Reference location — where it was published | `Submitted (04-FEB-2025) to the INSDC.` + address | Date from ENA; address from manifest `ADDRESS` | `call_loculus.get_address()`, built from the submitting group's address |
| `DR MD5` | Checksum cross-reference | `41ca0010...` | Computed by ENA | **none** |
| `DR BioSample` | Link to the sample record | `SAMEA117658922` | Our registered BioSample | our sample |
| `CC` | Free-text comment block | `Original sequence submitted to Pathoplexus with accession: PP_0011CQ4, version: 2` | **manifest `DESCRIPTION`** — not our `DE` line. This is the only free text we control on the published record | `get_description()` |
| `FT source` | The feature describing the sample the sequence came from | see §3 | **Entirely rebuilt from the BioSample.** Ours is deleted before validation | `config/defaults.yaml` |
| `FT assembly_gap` | Auto-generated features marking runs of `N` | `1..104`, `18330..18875` | ENA scans our sequence and creates one per run of ≥11 `N` | our sequence (trim leading/trailing Ns to avoid them) |
| `FT gene` / `CDS` / … | The annotation | *(absent — we don't submit any yet)* | Would come from our flat file verbatim | `preprocessing/.../embl.py`, pending PR #4503 |
| `SQ` header | Base composition tally | `5669 A; 3944 C; ...; 650 other;` | Recomputed by ENA | our sequence |
| sequence body | The bases | 10-base blocks, 60 per line | Ours — but lowercased, and any `U` is rewritten to `t` | our sequence |

**On `/segment="main"`:** that record predates loculus#3682. Current code writes `genome` for
monopartite organisms, so new monopartite records read `..., segment: genome`. Multi-segment
organisms (CCHF: `L`/`M`/`S`) get one chromosome-list row and one EMBL entry per segment, with
object names `PP_XXXXXXX_L` etc. and `linear-segmented` in column 3.

---

## 3. The `source` feature: all of it comes from the BioSample

This is the feature that carries the sample metadata, and it is the part people most often expect
to control from the flat file. We don't. ENA deletes ours and builds a new one by walking the
BioSample's attributes through a hardcoded list.

### What ends up there

| Qualifier | What it is | Example | Comes from |
|---|---|---|---|
| `/organism` | Scientific name | `Sudan ebolavirus` | BioSample `SCIENTIFIC_NAME` |
| `/mol_type` | Molecule type | `genomic RNA` | manifest `MOLECULETYPE` |
| `/db_xref` | Taxonomy cross-reference | `taxon:186540` | BioSample `TAXON_ID` |
| `/segment` | Which segment of a segmented genome | `main` | chromosome list column 2 |
| `/geo_loc_name` | Where the sample was collected, `Country:Region` | `Uganda:Kampala` | BioSample `geographic location (country and/or sea)` + `(region and locality)`, joined with `:` |
| `/collection_date` | When it was collected | `2025-01-19` | BioSample `collection date` |

### Why only those, out of the 18 attributes we sent

ENA lowercases each BioSample attribute name, applies a four-entry synonym map
(`host scientific name`→`host`, `collection date`→`collection_date`,
`metagenomic source`→`metagenome_source`, `gisaid accession id`→`note`), and then checks it against
a **hardcoded list of 15 permitted source qualifiers**. Anything else is dropped. Values in ENA's
missing-value vocabulary (`not provided`, `not collected`, `not applicable`, `missing`,
`restricted access`) are also dropped.

Traced for `SAMEA117658922`:

| BioSample attribute | Value | Outcome |
|---|---|---|
| `collection date` | `2025-01-19` | **→ `/collection_date`** |
| `geographic location (country and/or sea)` | `Uganda` | **→ `/geo_loc_name`** (merged) |
| `geographic location (region and locality)` | `Kampala` | **→ `/geo_loc_name`** (merged) |
| `isolate` | `not provided` | on the list, but the value is a missing-value placeholder → dropped |
| `host scientific name` | `Homo Sapiens` | → `host`, which is not on the list → dropped |
| `host age` | `32` | not on the list → dropped |
| `host sex` | `Male` | not on the list → dropped |
| `host disease outcome` | `Deceased` | not on the list → dropped |
| `host health state` | `not provided` | not on the list → dropped |
| `host common name` | `not provided` | not on the list → dropped |
| `host subject id` | `not provided` | not on the list → dropped |
| `collecting institution` | `The Central Public Health Laboratories; …` | not on the list → dropped |
| `collector name` | `not provided` | not on the list → dropped |
| `authors` | 26 names | not on the list → dropped (they reach `RA` via the manifest instead) |
| `receipt date` | `2025-01-19` | not on the list → dropped |
| `organism` | `Sudan ebolavirus` | not on the list → dropped (`/organism` comes from the taxon instead) |
| `scientific_name` | `Sudan ebolavirus` | not on the list → dropped |
| `ENA-CHECKLIST` | `ERC000011` | not on the list → dropped |

The lat/long we send (`geographic location (latitude)` / `(longitude)`, in decimal degrees) is
formatted by ENA into a `/lat_lon` string and then discarded, because `lat_lon` is not on the list
either.

---

## 4. What else we could put in

### 4a. Source qualifiers — the complete menu

These 15 names are the entire set of source qualifiers reachable from a BioSample. Everything else
is unreachable no matter how the sample is filled in. Changing any of these is a
`config/defaults.yaml` edit only — no flat-file change, no ENA involvement.

| Qualifier | What it is | Status today | What it would take |
|---|---|---|---|
| `isolate` | Sample/isolate identifier | mapped to `specimenCollectorSampleId`, falls back to `submissionId`; lands whenever it isn't the literal `not provided` | make sure real values flow |
| `isolation_source` | Physical/environmental source of the sample, e.g. `urine`, `bat guano` | **mapped but never lands** — we send `isolation source host-associated` / `isolation source non-host-associated`, neither of which matches | rename the attribute to `isolation_source` (or `environment (material)`) |
| `strain` | Strain designation | unmapped | pick a Loculus field |
| `serotype` | Serological variety | unmapped | relevant for RSV A/B, influenza subtypes |
| `serovar` | Serovar designation | unmapped | |
| `sub_species` | Subspecies | unmapped | (note: ENA drops this one at write time even though it's permitted) |
| `sub_strain` | Sub-strain | unmapped | |
| `variety` | Varietal name | unmapped | plant/fungal, not relevant |
| `cultivar` | Cultivar name | unmapped | plant, not relevant |
| `ecotype` | Ecotype | unmapped | plant, not relevant |
| `cell_line` | Cell line the sample was grown in | unmapped | possible for lab-passaged isolates |
| `environmental_sample` | Flag: sample is environmental, no isolated organism | unmapped | valueless flag qualifier |
| `metagenome_source` | Metagenome the sequence came from | unmapped | |
| `collection_date` | Collection date | **already lands** | — |
| `geo_loc_name` | Collection location | **already lands** | — |

Not reachable at all: `/host`, `/lat_lon`, `/collected_by`, `/note`, `/db_xref` beyond taxon.
ENA's code has a literal taxid check that allows `host`, `lat_lon`, `note`, `geo_loc_name` and
`collection_date` through only for SARS-CoV-2 (taxon 2697049). For every other organism the code
that formats `/lat_lon` runs and its result is thrown away.

### 4b. Annotation — the biggest addition available

Nothing is stopping us from submitting `gene` and `CDS` features. They pass through ENA verbatim,
and ENA adds `/locus_tag` propagation and `/transl_table` on top. The file already exists:
`preprocessing/.../embl.py` produces it for the user-facing download. PR #4503 would have
deposition submit that file instead of rebuilding a bare one.

What we'd send per CDS, from the existing fixture:

```
FT   gene            56..3007
FT                   /gene="NPEbolaSudan"
FT                   /product="NPEbolaSudan"
FT   CDS             458..2674
FT                   /gene="NPEbolaSudan"
FT                   /note="predominant component of nucleocapsid"
FT                   /product="nucleoprotein"
FT                   /codon_start=1
FT                   /translation="MNKRVRGSWALGGQSEVDLDYHKILTAGLSVQQGIVRQRVIPVYV…"
```

Three qualifiers are currently commented out in `EMBL_ANNOTATIONS` and worth reconsidering:
`locus_tag` (needs a prefix registered with ENA once, after which ENA propagates it from `gene` to
`mRNA` and `CDS` for free), `old_locus_tag`, and `db_xref` (the reference protein accession).
`/protein_id` is always stripped and replaced with an ENA-minted one, and `/translation` is
generated by ENA when absent — so neither needs to be supplied.

### 4c. Manifest fields we don't use

| Field | What it is | Note |
|---|---|---|
| `DESCRIPTION` | → the `CC` block | **already used** — currently the PPX accession + version. This is the one free-text slot on the record, so anything else we want visible (e.g. a GISAID cross-reference) would go here |
| `TPA` | Marks the assembly as third-party annotation of existing data | not set; would add `KW Third Party Data` |
| `MINGAPLENGTH` | Minimum run of `N` that becomes an `assembly_gap` | not set; ENA defaults to 11 |
| `ASSEMBLY_TYPE` | How the assembly was derived | our enum has only `clone` and `isolate`; we always send `isolate` |
| `RUN_REF` | Links the assembly to its raw reads | already set when raw reads exist |
| `SUBMISSION_TOOL` / `SUBMISSION_TOOL_VERSION` | Identifies the broker software | accepted by webin-cli, undocumented, unused by us |

### 4d. Not worth pursuing

- `/segment` in our flat file — ENA generates it from the chromosome list; writing our own would
  collide.
- `/translation` and `/transl_table` on CDS features — ENA derives both; supplying a `/transl_table`
  that disagrees with the sample's taxonomy is a hard error.
- `-context sequence`, the submission route that *would* preserve our source feature — it has no
  SAMPLE field at all, so no BioSample link, no `/segment`, and no GCA accession.

---

## 5. Summary

| Want to change… | Edit |
|---|---|
| anything in the `source` feature | `ena-submission/config/defaults.yaml` → `metadata_mapping` |
| organism name, taxon, mol_type, topology | the `enaDeposition` block in the Helm values |
| the `DE` title's segment suffix | `create_chromosome_list_object` |
| the `CC` comment | `get_description()` |
| authors / address | the `authors` Loculus field / `get_address()` |
| add annotation | merge PR #4503 |
| the flat file's own header or source feature | nothing — it is discarded |

---

*Caveat: what ENA does server-side is reconstructed from the client-side `sequencetools` library
rather than observed directly. The reconstruction predicts `OZ222062.1` qualifier-for-qualifier,
including ordering. The deeper investigation with source citations is in
[`../2026-09-16-embl-annotations-and-ena-internals/`](../2026-09-16-embl-annotations-and-ena-internals/).*
