# Independent oracles for GFF3+FASTA → CDS → protein, for viral genomes

**Date:** 2026-09-15
**Companion to:** [`2026-09-15-nextclade-robustness-audit.md`](2026-09-15-nextclade-robustness-audit.md)
**Motivation:** `gffread 0.12.9` is a poor oracle for viral annotation (no circular support,
heap corruption on overlapping CDS segments, ignores `transl_table`, drops `Is_circular`).
This file finds, installs and *tests* replacements.
**Reproducers:** `/workspaces/claude-devcontainer/scratch/nc-audit/oracles/`
**Envs created:** `vadr`, `t2a`, `agat`, `gt`, `emboss`, `bio` (see table below)

> The container is **linux-aarch64**. VADR and table2asn are linux-64-only in bioconda; they
> were installed under Rosetta emulation. That recipe is now the **`x86-emulation` skill**.

---

## 1. Recommendation — use these three

| Rank | Oracle | Why | Invocation |
|---|---|---|---|
| **1** | **Biopython from the GenBank flatfile** | The `/translation=` qualifier *is* ground truth. Reproduced **38/38** RefSeq proteins exactly across SARS-CoV-2, HBV, Ebola, HIV-1 — origin-spanning joins, ribosomal-slippage overlaps and all. Zero install friction. | `micromamba run -n bio python` + `SeqIO` / `feature.extract(rec.seq).translate()` |
| **2** | **`table2asn`** (NCBI submission engine) | The only *third-party* tool tested that got **every** hard case exactly right. Driven from GFF3 through the bridge in §4.7 it scores **28/28** on SARS-CoV-2+HBV+Ebola and **7/7** on SV40 (incl. the minus-strand wrap). Also emits a real diagnostic (`SEQ_FEAT.SeqLocOrder`) instead of silently truncating. Input is a 5-column `.tbl`, not GFF3 — that is a *feature*, since `.tbl` is lossless where GFF3 is not. | `micromamba run -n bio python gff3_to_tbl.py in.gff3 in.fa out.tbl` then `micromamba run -n t2a table2asn -i in.fsa -f out.tbl -o out.sqn -V bv -Z` |
| **3** | **VADR** (`v-annotate.pl`) | Not a GFF3 translator — it is the *catalogue of what can be wrong*. NCBI's own virus-submission validator. Its alert codes are a ready-made test plan (§5) and it pinpointed every defect injected into a SARS-CoV-2 genome with exact coordinates. | `micromamba run -n vadr v-annotate.pl -f -s --glsearch --mkey sarscov2 --mdir /opt/conda/envs/vadr/share/vadr-1.6.4/vadr-models in.fa out/` |

Also worth keeping:
- **`gt gff3validator`** (`gt` env) as a cheap spec-conformance gate — the **only** tool tested that
  honours `Is_circular` when range-checking (§4.1).
- **EMBOSS** `extractfeat -join` + `transeq` (`emboss` env) as a cheap *third* independent
  implementation — **7/7 exact on HBV** including the circular polymerase (§4.8). GenBank input only;
  it cannot read a standalone GFF3.

**Do not use as a translation oracle:** gffread, AGAT, BCBio.GFF, gffutils. All four silently
produce wrong proteins on real RefSeq viral GFF3 (§3, §4).

A corrected ~90-line reference implementation lives at
`scratch/nc-audit/oracles/gff3_oracle.py` — it reproduces 37/38 RefSeq proteins **from GFF3+FASTA**
(the 38th is unrecoverable from GFF3; see §4.5).

---

## 2. Install status — what actually works here

| Tool | Env | Arch | Status |
|---|---|---|---|
| Biopython 1.88, gffutils 0.14, BCBio.GFF, pyfaidx | `bio` | native | ✅ `micromamba create -n bio -c conda-forge -c bioconda biopython gffutils bcbio-gff pyfaidx` |
| genometools 1.6.6 (`gt`) | `gt` | native | ✅ `genometools-genometools` |
| AGAT 1.7.0 | `agat` | native (noarch Perl) | ✅ |
| EMBOSS 6.6.0 | `emboss` | native | ✅ |
| **VADR 1.6.4** | `vadr` | **linux-64 emulated** | ✅ aarch64 solve fails; `--platform linux-64` works. Models ship in-package. |
| **table2asn** | `t2a` | **linux-64 emulated** | ✅ same. Warns "more than 1 year old" — harmless. |
| gffread 0.12.9 | `gff-oracles` | native | pre-existing (the incumbent) |

Not installed, with reasons: **snpEff / VEP** (variant annotators, consume a *built* database, not
a GFF3→protein path; VEP needs a multi-GB cache), **Prokka / Bakta** (*de novo* bacterial callers —
they emit GFF3, they do not translate someone else's), **Artemis / Geneious** (GUI).

---

## 3. The incumbent: gffread crashes on the two most important viral genomes

Reproduced, not inherited:

```
$ gffread -g NC_045512.2.fa -y /dev/stdout NC_045512.2.gff3    # SARS-CoV-2
Error: discarding overlapping duplicate mature_protein_region_of_CDS feature (13468-16236) ...
malloc(): corrupted top size                                   # heap corruption

$ gffread -g NC_002549.1.fa -y /dev/stdout NC_002549.1.gff3    # Ebola Zaire
malloc(): invalid size (unsorted)
```

Both are on **NCBI's own unmodified RefSeq GFF3**. The SARS-CoV-2 crash is new information —
the known case was Ebola GP. Note gffread exits **0** after the heap error.

gffread also renders internal stop codons as `.`, not `*`.

---

## 4. Hard-case results

Test genomes (all NCBI RefSeq, GFF3 + FASTA + GenBank all fetched):

| Accession | Why |
|---|---|
| `NC_045512.2` SARS-CoV-2 | ORF1ab `join(266..13468,13468..21555)` — **1 nt overlap**, `exception=ribosomal slippage` |
| `NC_003977.2` HBV | **circular, 3182 bp**; P `join(2309..3182,1..1625)` spans the origin |
| `NC_002549.1` Ebola Zaire | GP `join(6039..6923,6923..8068)` overlap (RNA editing) *and* ssGP `join(6039..6922,6924..6933)` (1 nt **skip**) |
| `NC_001802.1` HIV-1 | gag-pol overlap, real spliced tat/rev with **non-zero phase on exon 2**, a **minus-strand CDS**, and Nef's `transl_except` |

### 4.1 Circular genomes / origin-spanning CDS — the headline finding

**NCBI's own GFF3 for a circular virus uses coordinates that run past the end of the sequence.**
HBV is 3182 bp; the polymerase CDS is emitted as:

```
NC_003977.2  RefSeq  region  1  3182  . + .  ID=...;Is_circular=true
NC_003977.2  RefSeq  CDS  2309  4807  . + 0  ...product=polymerase       # 4807 > 3182
```

`4807 - 3182 = 1625`, i.e. this *is* `join(2309..3182, 1..1625)`. Truth = **832 aa**, starts
`MPLSYQHFRRLL`.

| Tool | Result on the real NCBI file | Verdict |
|---|---|---|
| `gff3_oracle.py` (wrap-aware) | **832 aa, exact** | ✅ |
| `table2asn` (`.tbl` join form) | **832 aa, exact** + flags `SEQ_FEAT.SeqLocOrder` | ✅ |
| **gffread** | **291 aa** — correct prefix then silently stops at the end of the sequence | ❌ silent 65 % loss |
| **AGAT** | **291 aa** — identical silent truncation | ❌ |
| **BCBio.GFF** | extracts 874 nt instead of 2499 | ❌ |
| **gffutils** `.sequence()` | 874 nt | ❌ |

BCBio/gffutils are worse elsewhere in the same file: the middle envelope CDS `3174..4019`
(846 nt) comes back as **9 nt** — three codons — with no error.

**The spec-legal two-row form is worse still.** Written as two rows sharing an ID
(`2309..3182` + `1..1625`), *every* tool including my first draft returned a wrong 833 aa protein
beginning `NSTT` — because they all sort segments by ascending coordinate, which puts the
post-origin fragment first. AGAT's version carries 12 internal stops. GFF3 has **no way** to
express "this segment is biologically first" other than file order, and nobody honours file order.
→ This is exactly finding #1 and #5 of the parent audit, confirmed against four independent tools.

`Is_circular` handling: **`gt gff3validator` is the only tool that uses it.** With the flag it
accepts the out-of-range CDS; strip the flag and it correctly errors:

```
range (2309,4807) of feature on line 3 is not contained in range (1,3182) of
corresponding sequence region on line 2
```

gffread and AGAT produce the same 291 aa whether or not `Is_circular` is present — they never
read it.

### 4.2 Overlapping CDS segments (ribosomal slippage / RNA editing)

SARS-CoV-2 ORF1ab, truth = 7096 aa.

| Tool | Result |
|---|---|
| `gff3_oracle.py` | 7096 aa **exact** |
| `table2asn` | 7096 aa **exact** (`join{[265:13468](+), [13467:21555](+)}`) |
| gffread | **heap corruption**, no output |
| **AGAT** | 7096 aa that is **not** the right protein |

The AGAT case deserves emphasis because it is the most dangerous failure mode found:
AGAT merges the two overlapping segments into one interval, dropping the duplicated nucleotide
at the slippage site. The result agrees with truth for the first **4401** aa and is frameshifted
garbage after it, containing **172 internal stop codons** — emitted silently, exit 0.
AGAT also drops ORF1a entirely (it keeps one CDS per gene, so overlapping isoforms vanish):
11 proteins out for 12 CDS rows in.

### 4.3 Non-zero phase on a 5'-partial CDS

Constructed by trimming 1 or 2 nt off the SARS-CoV-2 S start and setting phase to 2 / 1.
**gffread, AGAT and the oracle all agree and are all correct** (`FVFLVLLPL…`). No divergence here —
this is the one hard case the ecosystem handles consistently. (Nextclade ignoring column 8 is
therefore squarely a Nextclade bug, not an ambiguous area — parent audit finding #4.)

### 4.4 Minus-strand multi-exon row ordering

A 2-exon minus-strand CDS presented with rows in ascending and in descending order.
**gffread and AGAT are correct in both orders.** My first draft was wrong — it sorted
descending *and* reverse-complemented the concatenation, which reverses exon order twice.
The correct rule, now in `gff3_oracle.py`:

> concatenate segments in **ascending genomic order**, reverse-complement the whole result once,
> and take `phase` from the **last** row for `-` strand (the biologically first segment).

Worth testing Nextclade against both row orders and both strands — this is an easy bug to write.

### 4.5 `transl_table` and `transl_except` — GFF3 is lossy

**`transl_table`:** a discriminating test (SARS-CoV-2 E with a TGA injected at codon 10; table 1
gives `MYSFVSEET*TLIV…`, table 4 gives `MYSFVSEETWTLIV…`) shows **no tool honours a per-CDS
`transl_table` GFF3 attribute** — not gffread (no such option at all), not AGAT (which has only a
global `--table` flag). If Nextclade ignores it, it is in universal company, but it is still wrong.

**`transl_except`:** NCBI's GFF3 writer **drops it entirely**. HIV-1 Nef (`NP_057857.2`) carries
`/transl_except=(pos:8712..8714,aa:Trp)` in GenBank — HXB2 genuinely has a TGA where a conserved
Trp belongs. The GFF3 row is just `8343 8963 + 0` with `product=Nef`.

Result: any GFF3-only tool yields a 206 aa Nef with an internal `*` at position **124**
(genome coord 8712) where truth has **W**. Verified. This is a hard *limit*, not a bug — but it is
a clean regression test for "does the tool at least not crash / does it flag the internal stop".

### 4.6 Summary matrix

| Case | oracle.py | table2asn | EMBOSS¹ | gffread | AGAT | BCBio/gffutils | gt |
|---|---|---|---|---|---|---|---|
| Circular, NCBI out-of-range (+ strand) | ✅ | ✅ | ✅ | ❌ truncates | ❌ truncates | ❌ truncates | ✅ validates only |
| **Circular wrap, − strand (SV40)** | ✅ | ✅ | ✅ | ❌ **wrong protein** | ❌ **wrong protein** | — | — |
| Circular, two-row join | ❌* | ✅ | ✅ | ❌ | ❌ | ❌ | n/a |
| Overlapping CDS segs | ✅ | ✅ | ✅ | 💥 crash | ❌ wrong, 172 stops | — | ✅ valid |
| Minus-strand **spliced** multi-exon | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| 5'-partial non-zero phase | ✅ | ✅ | n/a | ✅ | ✅ | — | ✅ |
| Minus-strand row order (asc/desc) | ✅ | ✅ | n/a | ✅ | ✅ | — | ✅ |
| `transl_table` attribute | ❌ | n/a | n/a | ❌ | ❌ | ❌ | ❌ |
| `transl_except` | ❌ (lossy) | ✅ via .tbl | ✅ | ❌ | ❌ | ❌ | ❌ |

¹ EMBOSS reads **GenBank**, not GFF3 — so it cannot be fooled by GFF3's lossiness, but it also
cannot audit a GFF3 path. Use it as an independent cross-check of the truth, not of the parser.

\* unfixable from GFF3 alone without a "try rotations" heuristic; `.tbl`/GenBank express it correctly.

### 4.7 The GFF3 → `.tbl` → table2asn bridge (recommended oracle)

`table2asn` is authoritative but does not read GFF3. `scratch/nc-audit/oracles/gff3_to_tbl.py`
converts GFF3 to a 5-column feature table, expanding the NCBI out-of-range circular idiom into two
explicit intervals and reversing interval order for `-` strand:

```sh
micromamba run -n bio python gff3_to_tbl.py in.gff3 in.fa out.tbl
cp in.fa in.fsa
micromamba run -n t2a table2asn -i in.fsa -f out.tbl -o out.sqn -V bv -Z
# proteins + diagnostics land in out.gbf / out.val
```

Verified end to end against the RefSeq `/translation=` values:

| genome | result |
|---|---|
| `NC_003977.2` HBV (circular) | 7/7 exact |
| `NC_045512.2` SARS-CoV-2 (overlap) | 12/12 exact |
| `NC_002549.1` Ebola (overlap + skip) | 9/9 exact |
| `NC_001669.1` SV40 (minus-strand wrap) | 7/7 exact |
| **total** | **35/35 exact** |

The `.val` file is a second defect catalogue, complementary to VADR's:

- `SEQ_FEAT.SeqLocOrder` — *"Intervals out of order in SeqLoc"*. Fires on **every** origin-spanning
  CDS. This is a ready-made **detector for the circular case**.
- `SEQ_FEAT.NotSpliceConsensusDonor` / `NotSpliceConsensusAcceptor` — fires on the Ebola
  overlap/skip joins, which are not real splices.
- `SEQ_FEAT.UnnecessaryException` — *"CDS has exception but passes translation test"*.

### 4.8 The decisive case: minus-strand origin-spanning CDS (SV40)

**SV40 `NC_001669.1`, `NP_043122.1`** — `complement(join(5188..5243,1..16))` on a 5243 bp circular
genome. NCBI's GFF3 renders it as a **single out-of-range minus row**: `CDS 5188 5259 -`.
Truth = 23 aa `MQRPRPPRPLSYSRSSEEAFLEA`.

The two candidate implementations diverge completely:

```
correct  revcomp(A+B)          = MQRPRPPRPLSYSRSSEEAFLEA
wrong    revcomp(A)+revcomp(B) = RLGL*AIPEVVRRLFWRPRCRGRG
```

| tool | output |
|---|---|
| `gff3_oracle.py` | 23 aa **exact** ✅ |
| `table2asn` (via bridge) | 23 aa **exact** ✅ |
| Biopython from GenBank | 23 aa **exact** ✅ |
| **gffread** | `RLGL.AIPEVVRRLFWRP` — 18 aa, wrong ❌ |
| **AGAT** | `RLGL*AIPEVVRRLFWRP` — 18 aa, wrong ❌ |

The rule that makes it correct: **splice first, reverse-complement once, at the end.**
`revcomp(A)+revcomp(B)` is the classic wrong form and is what the wrong column above shows.

### 4.9 Corpus sweep: 40 geminivirus RefSeqs

40 `Geminiviridae` RefSeq genomes (all circular; 8 carry a minus-strand **spliced** Rep `C1:C2`,
1 carries a genuinely **origin-spanning** CDS), scored against their own `/translation=`:

| tool | exact |
|---|---|
| `gff3_oracle.py` | **208/208** |
| gffread | 207/208 |
| AGAT | 207/208 |

**This is an important negative result.** gffread and AGAT handle minus-strand *multi-exon/spliced*
CDS correctly. Their single failure in the whole corpus is `NC_075135.1` / `NP_039916.1` — the one
**origin-spanning** CDS, `join(2689..2690,1..304)`, emitted by NCBI as `CDS 2689 2994 +` on a
2690 bp genome.

So the systematic external failure mode is specifically **the wrap**, not minus-strand splicing.

> **Correction (resolved with the parent audit).** An earlier draft of this file inferred from the
> 207/208 result that Nextclade's ~25 failing geminivirus Reps implied a *second, splice-ordering*
> bug. That inference was wrong — it was a sample-size artefact. The parent audit's full sweep
> covers **818** Geminiviridae RefSeqs (of 2,426 across 14 circular families) and finds **19**
> family-level wraps = **2.3 %**; my 1-in-40 = 2.5 % is the same rate. All 31 of its failing CDSes
> are origin-crossing wraps and **28 of the 31 are single-row features** with no splicing at all,
> so they are one defect, not a mix. Nextclade's minus-strand *splice*-ordering bug is real but
> **latent**: 0 of 463 real minus-strand multi-row RefSeq CDSes are mis-ordered, because NCBI emits
> them descending; it only activates after `sort -k4,4n` or `gffread -o`.
>
> Cross-check on the parent's 31 failing cases, same GFF3+FASTA Nextclade receives:
> **`gff3_oracle.py` 29/31 exact vs RefSeq protein; Nextclade 0/31.** The 2 the oracle also misses
> are the pathological "segment entirely past the landmark end" records (`NC_027792.1`, and one CDS
> of `NC_039069.1`) — a distinct edge case.

### 4.9b `SEQ_FEAT.SeqLocOrder` is a precise origin-crossing detector

Tested on SV40, whose `.tbl` contains a minus-strand **wrap** *and* a minus-strand **spliced,
non-wrapping** CDS — so the alert's specificity can be measured, not assumed:

| feature | intervals | alert |
|---|---|---|
| `NP_043122.1` — minus-strand **wrap** | `c16-1, c5243-5188` | **`SEQ_FEAT.SeqLocOrder`** ✅ |
| `NP_043127.1` large T — minus-strand **spliced, no wrap** | `5163-4918, 4571-2691` | none |
| all plus-strand single-interval CDS | — | none |

So it fires **exactly** on the origin-crossing feature, on the minus strand, and does **not**
false-positive on ordinary minus-strand multi-exon CDS.

**Caveat — it is conditional on topology.** The above holds when the record is *not* declared
circular. Adding `[topology=circular]` to the FASTA defline **suppresses `SeqLocOrder`** (correctly:
on a circle the intervals *are* in order), leaving only an unrelated
`SEQ_INST.CompleteCircleProblem` nag. Translations are **7/7 exact either way** — table2asn is
correct in both modes and the alert is purely diagnostic.

Read the semantics as: *"these intervals only make sense on a circle."* That is precisely the
condition a GFF3 consumer needs to detect before it can translate the feature correctly.

### 4.10 AGAT's repair does not do what its docs claim

`agat_convert_sp_gxf2gxf.pl` on a deliberately broken GFF3 (`broken.gff3` → `fixed.gff3`, both in
`scratch/nc-audit/oracles/`) containing: a CDS with no `Parent`, a CDS with a dangling `Parent`,
**two different CDSs sharing `ID=cdsA`**, and a CDS with `phase='.'`:

- It **merged three unrelated CDSs (S, ORF3a, M) into a single invented transcript**
  `agat-rna-1` spanning 21563..27191, turning them into three "exons" of one fake gene. Translating
  that gives nonsense.
- It did **not** fix the duplicate identifier — `ID=cdsA` still appears **twice** in the output,
  directly contradicting the documented *"It fixes identifier to be uniq."*
- It left `phase='.'` unrepaired.
- It invented `gene`/`mRNA`/`exon` layers that have no meaning for a viral genome.

Treat AGAT's fix-list (§6) as a catalogue of *inputs to test*, never as a repair step in a viral
pipeline.

### 4.11 EMBOSS — a correct but GenBank-only oracle

`extractfeat` **cannot read a standalone GFF3 next to a FASTA** (it silently writes zero sequences;
`gff::file.gff` is rejected outright). It reads features only from feature-bearing formats.
From GenBank it is correct, including both hard cases:

```sh
micromamba run -n emboss extractfeat -sequence x.gb -type CDS -join -outseq cds.fa
micromamba run -n emboss transeq -sequence cds.fa -table 0 -trim -outseq prot.fa
```

- HBV: **7/7 exact**, incl. the 832 aa origin-spanning polymerase (extracted lengths 2499/1170/846).
- SARS-CoV-2 ORF1ab: 21291 nt — the overlapping join handled correctly.
- `transeq -table` supports the full NCBI set (0,1,2,3,4,5,6,9,10,11,12,13,14,15,16,21,22,23) —
  note EMBOSS numbering, where **0 = Standard** and 1 = "Standard with alternative initiation codons".

Caveat: output FASTA headers are useless for matching (every HBV record is `NC_003977_1_3182`);
match by order or length.

---

## 5. VADR alert catalogue — the real-world viral-annotation defect list

Generated verbatim by `micromamba run -n vadr v-annotate.pl --alt_list`
(full output: `scratch/nc-audit/oracles/vadr_alt_list.txt`). **S** = sequence-level,
**F** = feature-level. Gloss = the input condition it corresponds to.

### Always fatal

| code | name | input condition |
|---|---|---|
| `noannotn` | NO_ANNOTATION | nothing matched the model at all |
| `revcompl` | REVCOMPLEM | the submitted sequence is reverse-complemented |
| `unexdivg` | UNEXPECTED_DIVERGENCE | too divergent to annotate by nucleotide homology |
| `noftrann` | NO_FEATURES_ANNOTATED | the matching region overlaps no feature |
| `noftrant` | NO_FEATURES_ANNOTATED | every feature is too short to emit |
| `ftskipfl` | UNREPORTED_FEATURE_PROBLEM | the only fatal alerts are on features not in the table |

### Fatal by default (the CDS-translation ones are the audit gold)

| code | name | input condition |
|---|---|---|
| `mutstart` | MUTATION_AT_START | **expected start codon is not there** |
| `mutendcd` | MUTATION_AT_END | expected stop codon absent; homology-predicted stop is invalid |
| `mutendns` | MUTATION_AT_END | **no in-frame stop exists anywhere 3' of the start** (runs off the end) |
| `mutendex` | MUTATION_AT_END | first in-frame stop is **downstream** of the expected stop (readthrough) |
| `unexleng` | UNEXPECTED_LENGTH | **complete CDS length not a multiple of 3** |
| `cdsstopn` | CDS_HAS_STOP_CODON | **premature in-frame stop** (nucleotide alignment) |
| `cdsstopp` | CDS_HAS_STOP_CODON | premature stop seen in the protein alignment |
| `fsthicft` | POSSIBLE_FRAMESHIFT_HIGH_CONF | high-confidence frameshift, **frame not restored** |
| `fsthicfi` | POSSIBLE_FRAMESHIFT_HIGH_CONF | high-confidence frameshift, frame restored before the end |
| `fstukcft` / `fstukcfi` | POSSIBLE_FRAMESHIFT | same, under `--glsearch` |
| `mutspst5` / `mutspst3` | MUTATION_AT_SPLICE_SITE | intron does not start `GT` / end `AG` (spliced viral CDS) |
| `peptrans` | PEPTIDE_TRANSLATION_PROBLEM | mat_peptide untranslatable because its **parent CDS** is broken |
| `pepadjcy` | PEPTIDE_ADJACENCY_PROBLEM | mat_peptides that must abut do not |
| `indfantp` / `indfantn` | INDEFINITE_ANNOTATION | protein search finds a CDS the nucleotide search does not, or vice versa |
| `indf5gap` / `indf3gap` | INDEFINITE_ANNOTATION_START/END | alignment is a **gap at the feature boundary** |
| `indf5lcn` / `indf3lcn` | INDEFINITE_ANNOTATION_START/END | low-confidence boundary, non-CDS feature |
| `indf5plg` / `indf3plg` | INDEFINITE_ANNOTATION_START/END | protein alignment extends **past** the nucleotide one |
| `indf5pst` / `indf3pst` | INDEFINITE_ANNOTATION_START/END | protein alignment falls **short** of the nucleotide one |
| `indfstrp` | INDEFINITE_STRAND | protein- and nucleotide-based predictions disagree on strand |
| `insertnp` | INSERTION_OF_NT | oversized insertion (protein alignment) |
| `deletinp` | DELETION_OF_NT | oversized deletion (protein alignment) |
| `deletinf` | DELETION_OF_FEATURE_SECTION | **one segment of a multi-segment feature is entirely deleted** |
| `lowsim5n/5l/3n/3l/in/il` | LOW_FEATURE_SIMILARITY_* | region overlapping a non-CDS feature lacks similarity (n/l = short/long) |
| `incsbgrp` / `incgroup` | INCORRECT_SPECIFIED_(SUB)GROUP | declared group disagrees with the best-scoring model |
| `lowcovrg` | LOW_COVERAGE | too little of the sequence matches the model |
| `dupregin` | DUPLICATE_REGIONS | **a model region matches more than once** (duplication / assembly artefact) |
| `discontn` | DISCONTINUOUS_SIMILARITY | hits are not colinear between sequence and model (**rearrangement**) |
| `indfstrn` | INDEFINITE_STRAND | significant similarity on **both** strands |
| `lowsim5s` / `lowsim3s` / `lowsimis` | LOW_SIMILARITY_START/END/— | 5', 3' or internal region without similarity |
| `nmiscftr` | TOO_MANY_MISC_FEATURES | too much of the record demoted to `misc_feature` |
| `deletins` | DELETION_OF_FEATURE | a whole feature is internally deleted |

### Non-fatal by default

| code | name | input condition |
|---|---|---|
| `qstsbgrp` / `qstgroup` | QUESTIONABLE_SPECIFIED_(SUB)GROUP | best model is outside the declared group |
| `ambgnt5s` / `ambgnt3s` | AMBIGUITY_AT_START/END | first / last nucleotide of the **sequence** is ambiguous |
| `ambgnt5f` / `ambgnt3f` | AMBIGUITY_AT_FEATURE_START/END | first / last nt of a non-CDS feature is ambiguous |
| `ambgnt5c` / `ambgnt3c` | AMBIGUITY_AT_CDS_START/END | first / last nt of a **CDS** is ambiguous |
| `ambgcd5c` / `ambgcd3c` | AMBIGUITY_IN_START/STOP_CODON | start/stop codon begins canonically but contains an **N** |
| `indfclas` | INDEFINITE_CLASSIFICATION | top two models score too closely |
| `lowscore` | LOW_SCORE | below the model score threshold |
| `biasdseq` | BIASED_SEQUENCE | score driven by compositional bias |
| `extrant5` / `extrant3` | EXTRA_SEQUENCE_START/END | **extra sequence beyond the expected genome ends** (vector/adapter) |
| `unjoinbl` | UNJOINABLE_SUBSEQ_ALIGNMENTS | seed and flanking alignments disagree on the overlap |
| `deletina` | DELETION_OF_FEATURE | an explicitly deletable feature is absent |
| `ambgntrp` | N_RICH_REGION_NOT_REPLACED | N-run of unexpected length during N-replacement |
| `fstlocft` / `fstlocfi` | POSSIBLE_FRAMESHIFT_LOW_CONF | low-confidence frameshift, not / restored |
| `indf5lcc` / `indf3lcc` | INDEFINITE_ANNOTATION_START/END | low-confidence boundary on a CDS |
| `insertnn` / `deletinn` | INSERTION/DELETION_OF_NT | oversized indel in the nucleotide alignment of a CDS |
| `lowsim5c` / `lowsim3c` / `lowsimic` | LOW_FEATURE_SIMILARITY_* | CDS-matching region lacking similarity |
| `nnindfcl` / `nnloidcl` | INDEFINITE/LOW_ID_CLASSIFICATION_NN | nearest-neighbour classification is weak |
| `nnalrgcl` / `nnptrgcl` | ALT/PARTIAL_REGION_CLASSIFICATION_NN | the specified alignment region is missing or partial |
| `recombin` | POSSIBLE_RECOMBINATION | nearest neighbour **switches subgroup at a breakpoint** (`--do_rc`) |

### VADR verified end-to-end here

Five SARS-CoV-2 sequences with defects injected on purpose; VADR located every one with exact
coordinates in ~3 s:

| input | alerts fired |
|---|---|
| unmodified RefSeq | none — PASS |
| TAA injected at 21863 | `cdsstopn` + `cdsstopp` at **21863..21865** ✓ |
| 1 nt deleted at 22001 | `unexleng`, `cdsstopn`, `fstukcft` (22001..25383), `indf5pst` ✓ |
| S start ATG→CTG | **PASS** — did not fire `mutstart` (alternative start accepted; use `--atgonly`) |
| truncated at 26000 | PASS |

### VADR's scope limits (checked in source, not assumed)

- **Does not consume GFF3, does not emit GFF3.** `v-build.pl` takes a GenBank flatfile or an
  NCBI 5-column feature table; `v-annotate.pl` takes FASTA + a model and emits `.tbl`.
- **No circular-genome support at all** — `grep -riE 'circular' $VADRSCRIPTSDIR` returns nothing.
- **But `v-build.pl` does the right thing on a circular GenBank record.** Building a model from
  HBV (`v-build.pl --gb --ingb hbv.gb NC_003977 out/`, ~86 s) yields
  `coords:"2309..3182:+,1..1625:+"` — the wrap correctly split into two **ordered** segments
  (`hbv-vadr-model.minfo` in the reproducer dir). It then tags them `canon_splice_sites:"1"`,
  i.e. it treats the origin junction as a **splice site**, so annotating with that model should be
  expected to emit spurious `mutspst5`/`mutspst3` MUTATION_AT_SPLICE_SITE alerts at the origin.
  Useful as a model-format reference; not a circular-aware annotator.
- Its model format is *more* expressive than GFF3: `coords:"266..13468:+,13468..21555:+"` carries
  **per-segment strand** plus `exception:"ribosomal slippage"` in one field.

---

## 6. AGAT's "what we fix" list

Verbatim from `docs/agat_how_does_it_work.md` (AGAT 1.7.0, repo active — last push 2026-09-07,
588 stars, GPL-3.0). Each line is a real-world GFF3 breakage worth a Nextclade test:

* It creates missing parental features (a level2/level3 feature with no parent gets one invented).
* It creates missing mandatory attributes (`ID` and/or `Parent`).
* It fixes identifiers to be unique.
* It removes duplicated features (same position, same ID, same Parent).
* It expands level3 features sharing multiple parents (one exon listing several parent mRNAs
  becomes one exon per parent with a unique ID).
* It fixes feature location errors (e.g. an mRNA spanning beyond its gene — the *gene* is widened).
* It adds UTRs if possible (needs CDS and exon).
* It adds exons if possible (needs CDS).
* It groups features together when related features are **spread at different places in the file**.

From `docs/why_agat.md`: the author reports **more than 30 distinct malformed-input cases**, and
AGAT additionally merges overlapping loci (opt-in) and guarantees topological sorting (parents
emitted before children).

**Caveat, measured:** this list is about *structural* repair of eukaryotic-style GFF3. None of it
extends to viral coordinate semantics — AGAT is the tool that produced a 7096 aa protein with 172
internal stops (§4.2) and truncated HBV's polymerase to 291 aa (§4.1). Use its fix-list as a
**test-case catalogue**, not its output as an oracle.

Relevant AGAT tools if you do want structural normalisation:
`agat_convert_sp_gxf2gxf.pl` (repair/standardise), `agat_sp_extract_sequences.pl -t cds -p`
(protein extraction — but see the caveat).

---

## 7. Suggested Nextclade regression set

Every one of these is a real RefSeq file, already downloaded to
`scratch/nc-audit/oracles/`, with truth available from the matching `.gb`:

1. `NC_003977.2` (HBV) — out-of-range circular CDS `2309..4807` on a 3182 bp genome; expect
   832 aa polymerase. Also the two-row `join` rewrite in `cases/c1_tworow.gff3`, and
   `cases/c1_noflag.gff3` (same coords, no `Is_circular` → must be a clean *error*, not a panic).
2. `NC_045512.2` (SARS-CoV-2) — ORF1ab overlapping join; expect 7096 aa **and** ORF1a 4405 aa
   as two separate products from the same gene.
3. `NC_002549.1` (Ebola) — GP overlap join *and* ssGP's 1 nt **skip** join.
4. `NC_001802.1` (HIV-1) — spliced tat/rev with non-zero phase on exon 2, a minus-strand CDS,
   and Nef's dropped `transl_except` (expect an internal `*` at aa 124 — flag it, don't crash).
4b. **`NC_001669.1` (SV40) — the single highest-value case.** `NP_043122.1`, GFF3 row
   `CDS 5188 5259 -` on a 5243 bp genome. Must give 23 aa `MQRPRPPRPLSYSRSSEEAFLEA`.
   Getting `RLGL*AIPEVVRRLFWRPRCRGRG` (or any 18 aa prefix of it) means the code is doing
   `revcomp(A)+revcomp(B)` instead of `revcomp(A+B)`. The same file's `NP_043127.1` (708 aa large T,
   minus-strand spliced, **not** wrapping) must stay correct — it is the control that separates a
   wrap bug from a splice-ordering bug.
4c. **`circ/gem/` — 40 geminivirus RefSeqs, 208 proteins**, truth in `circ/gem.gb`. 8 have
   minus-strand spliced Rep; `NC_075135.1` has the only true wrap. Expect 208/208.
5. `cases/c2_phase{0,1,2}.gff3` — 5'-partial phase.
6. `cases/c3_{asc,desc}.gff3` — minus-strand 2-exon CDS in both row orders; both must give
   the same protein.
7. `cases/c4b_t4.gff3` — per-CDS `transl_table=4` with an internal TGA; table 4 must give `W`.

Check with `micromamba run -n bio python scratch/nc-audit/oracles/gff3_oracle.py <gff3> <fa>`,
or authoritatively via `gff3_to_tbl.py` + `table2asn` (§4.7).

## 8. Reproducer inventory

`/workspaces/claude-devcontainer/scratch/nc-audit/oracles/` (2.6 MB):

| path | what |
|---|---|
| `gff3_oracle.py` | wrap-aware GFF3+FASTA → protein reference implementation |
| `gff3_to_tbl.py` | GFF3 → NCBI 5-column feature table bridge for table2asn |
| `NC_045512.2.*`, `NC_003977.2.*`, `NC_002549.1.*`, `NC_001802.1.*` | SARS-CoV-2 / HBV / Ebola / HIV-1, each as `.gff3` + `.fa` + `.gb` (truth) |
| `circ/NC_001669.1.*` | SV40 — the minus-strand wrap case |
| `circ/gem.gb`, `circ/gem/` | 40 geminivirus RefSeqs (GenBank truth + per-accession GFF3/FASTA) |
| `cases/` | synthetic hard cases: `c1_*` circular idioms, `c2_phase*` 5'-partial phase, `c3_{asc,desc}` minus-strand row order, `c4b_t4` `transl_table=4` with an internal TGA |
| `bridge/*.tbl` | generated feature tables |
| `broken.gff3` / `fixed.gff3` | AGAT repair input/output (§4.10) |
| `hbv-vadr-model.minfo` | VADR's own encoding of HBV's circular CDSs |
| `vadr_alt_list.txt` | verbatim `v-annotate.pl --alt_list` output |

Install recipe for the emulated (linux-64) tools: the **`x86-emulation` skill**, written during
this investigation (`claude-config/skills/x86-emulation/SKILL.md`).
