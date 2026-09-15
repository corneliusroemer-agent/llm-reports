# Nextclade GFF3 → CDS → translation robustness audit

**Date:** 2026-09-15
**Target:** `nextstrain/nextclade`, Rust core (`packages/nextclade`)
**Source clone:** `/workspaces/claude-devcontainer/scratch/2026-09-15-nextclade-src`
**Scratch / reproducers:** `/workspaces/claude-devcontainer/scratch/nc-audit`
**Binary under test:** `micromamba run -n loculus-nextclade nextclade3` → **3.23.0**
**Oracles:** NCBI RefSeq protein records (primary), `gffread 0.12.9` (secondary)

---

## Version / "current main" status — read this first

The repo's default branch is **`master`, not `main`** (`git fetch origin main` → `couldn't find remote ref main`).

```
$ git fetch origin master && git log -1 --format='%ci %H' origin/master
2026-08-19 11:30:16 +0000 629ea8fb0cfe3165db13ddc75dab16d3c2292dbd
$ git rev-list --count HEAD..origin/master
0
```

`origin/master` is `chore: release 3.23.0` and is **identical to the local HEAD**. Main has not moved
past 3.23.0 and the binary under test *is* 3.23.0, so every behavioural result below is a direct
observation of current upstream. **No finding is already fixed.**

---

## Headline

**Nextclade produces a wrong protein for every real NCBI RefSeq viral genome that has a
minus-strand CDS crossing the origin of a circular genome.** Tested exhaustively: **31 out of 31**
such CDSes (in 29 genomes) found across 2,426 circular-virus RefSeqs fail — 26 silently produce a wrong protein,
3 produce an empty or misnamed garbage translation, 2 abort the whole dataset. **Zero produce the
correct protein.** Affected genomes include **SV40** and the **Rep / AC1 / AL1 replication protein
of ~25 geminiviruses** — the essential replication gene of one of the largest plant-virus families.

This is not a synthetic edge case. It is the standard GFF3 circular encoding, emitted by NCBI's own
`annotwriter`, on RefSeq records, for a gene family of real agricultural importance.

And the input is not ambiguous: an **independently written 90-line Python script**, given the *same*
GFF3 + FASTA, reproduces the RefSeq protein for **29 of those 31** (Nextclade: 0 of 31). NCBI's own
`table2asn` gets SV40 7/7 exact. The information is all there.

---

## Summary table

| # | Finding | Severity | Real-world status | Class |
|---|---------|----------|-------------------|-------|
| **1** | **Minus-strand CDS crossing a circular origin → wrong protein** | **Critical** | **ACTIVE: 31/31 real RefSeqs fail** | (a) confirmed bug |
| **2** | CDS segments concatenated in **GFF row order**, never sorted by strand+coordinate | **Critical** | **Latent** in NCBI data (0/463 currently mis-ordered); **activated** by `gffread -o` or `sort -k1,1 -k4,4n` | (a) confirmed bug |
| **3** | **Panic** (`index out of bounds`) when annotation coordinates exceed the *reference FASTA* length | **High** | Triggerable by any annotation/reference length mismatch | (a) confirmed bug |
| 3b | **Panic** (`assert!(begin <= end)`) on `start > end`; the existing error for that case is unreachable | Medium | — | (a) confirmed bug |
| **4** | `chunk_by` groups only **consecutive** rows → valid GFF3 rejected, or one CDS silently split | **High** | The ordinary `exon,CDS,exon,CDS` layout fails | (a) confirmed bug |
| 4b | CDS segments grouped by `ID` only, never `Parent` → **cannot read `gffread -o` output** | Medium | — | (b) interop |
| **5** | GFF3 **phase column ignored** on input, overwritten on output → 5'-partial CDS in wrong frame | **High** | No official dataset affected today | (a) confirmed bug |
| **6** | A bare `gene` with no CDS child whose length ∤ 3 **rejects the entire dataset** | **High** | **ACTIVE**: real RefSeq `NC_003866.1` unusable | (a) confirmed bug |
| **7** | Wrap segment lying **entirely** past the landmark end → inverted range + misleading error, or zero-length part | Medium | **ACTIVE**: `NC_027792.1`, `NC_001466.1` | (a) confirmed bug |
| 8a | `Is_circular` dropped from exported `region`; phase not recomputed for split wrap parts | Low | — | (a) confirmed bug |
| 8b | `gene` range of a wrapping CDS becomes the whole genome | Low | — | (b) surprising |
| 9a | Mixed-strand segments → translation written, *then* opaque internal error | Low | — | (a) minor bug |
| 9b | strand `?` / `.` silently treated as `+` on a CDS | Low | — | (b) surprising |
| 9c | `transl_table` ignored (standard code only) | Info | — | (b) same as gffread |
| **10** | **`transl_except` parsed but never applied** → shipped HIV-1 dataset emits `nef` with an internal stop | Medium | **ACTIVE**: official `community/neherlab/hiv-1/hxb2` | (a) confirmed bug |
| ✅ | Overlapping CDS segments (ribosomal slippage / RNA editing) | — | **Correct** — and more robust than gffread | (c) not a bug |
| ✅ | Plus-strand circular origin-crossing CDS (HBV) | — | **Correct** — verified against RefSeq | (c) not a bug |
| ✅ | Truncation reporting, IUPAC/`N`, adjacent segments, partial queries | — | **Correct** — 9,823 differential comparisons clean | (c) not a bug |

---

## Evidence base

* **Full GFF3 spec v1.26** — cloned, not excerpted: `git clone https://github.com/The-Sequence-Ontology/Specifications`
  → `scratch/nc-audit/specs/so-spec/gff3.md`, 60,468 bytes, md5 `61b5f48c1dd9bf98574c19696d0f9cc9`.
  (An earlier partial fetch saw only the first 39,372 bytes and missed the entire **Pathological Cases**
  section; that section is quoted below.)
* **Full INSDC Feature Table v11.4** — `scratch/nc-audit/specs/FT_current.txt` (182,900 bytes, ENA mirror)
  and `insdc-feature-table.html` (224,252 bytes).
* **All 106 official Nextclade datasets** downloaded and swept (`scratch/nc-audit/ncds/`).
* **2,426 circular-virus RefSeq GFF3s** across 14 families, scanned (`/tmp/circvir/`).
* **31 real failing genomes** rebuilt as datasets and compared against their RefSeq proteins
  (`scratch/nc-audit/cv/`), and independently re-checked with a second, separately written oracle.
* **Companion investigation:** `../2026-09-15-gff3-protein-oracles.md` — which GFF3→protein tools can
  serve as oracles for viral annotation (`table2asn`, `gt`, VADR, AGAT, gffread benchmarked and
  installed; VADR's ~90-code alert catalogue transcribed). Read it before picking an oracle: gffread
  is **not** a safe one here.

---

# Finding 1 — Minus-strand CDS crossing a circular origin yields a wrong protein

**Severity: Critical. Silent. Active on real NCBI RefSeq data today.**

## The mechanism

For a circular landmark, `split_circular_cds_segments` chops an origin-crossing segment into parts
and emits them in **ascending genomic order**, unconditionally:

```rust
// packages/nextclade/src/gene/cds.rs:242-311
pub fn split_circular_cds_segments(segments: &[CdsSegment]) -> Result<Vec<CdsSegment>, Report> {
  ...
      // first part: begin .. landmark_end          -> WrappingPart::WrappingStart
      // later parts: landmark_start .. (end % len) -> WrappingCentral / WrappingEnd
```

`segment.strand` is never consulted. Translation then reverse-complements **each part separately**
and concatenates them in that order:

```rust
// packages/nextclade/src/translate/extract.rs:57-69
.flat_map(|cds_segment| {
    let mut nucs = seq[cds_segment.range.to_std()].to_vec();
    if cds_segment.strand == GeneStrand::Reverse { reverse_complement_in_place(&mut nucs); }
    nucs
})
```

So Nextclade computes `revcomp(A) ++ revcomp(B)` where the correct answer is `revcomp(A ++ B)`.
On the plus strand ascending order *is* translation order, so only the minus strand breaks.

Per the spec, the 5' end of a minus-strand CDS is **the feature's end** — which for a wrap is the
part *after* the origin. That part must come **first**.

## Reproducer — SV40, `NC_001669.1`

```sh
mkdir -p /tmp/sv40 && cd /tmp/sv40
curl -sL "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=NC_001669.1&rettype=fasta&retmode=text" -o reference.fasta
curl -sL "https://eutils.ncbi.nlm.nih.gov/sviewer/viewer.cgi?db=nuccore&report=gff3&id=NC_001669.1&retmode=text" -o genome_annotation.gff3
cat > pathogen.json <<'JSON'
{"schemaVersion":"3.0.0","files":{"genomeAnnotation":"genome_annotation.gff3","pathogenJson":"pathogen.json","reference":"reference.fasta"},"attributes":{"name":"sv40"}}
JSON
micromamba run -n loculus-nextclade nextclade3 run --input-dataset . --output-all out reference.fasta
grep -v '>' out/nextclade.cds_translation.NP_043122.1.fasta
curl -sL "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id=NP_043122.1&rettype=fasta&retmode=text"
```

The annotation is a single unmodified RefSeq line, in the exact form the GFF3 spec prescribes:

```
NC_001669.1  RefSeq  region  1     5243  .  +  .  ID=NC_001669.1:1..5243;Dbxref=taxon:1891767;Is_circular=true;...
NC_001669.1  RefSeq  CDS     5188  5259  .  -  0  ID=cds-NP_043122.1;Parent=gene-SV40gp1;Name=NP_043122.1;...
```
(genome length 5243, so `5188..5259` = genomic `5188..5243` ++ `1..16`, on the minus strand)

| | |
|---|---|
| **NCBI `NP_043122.1`** | `MQRPRPPRPLSYSRSSEEAFLEA` (23 aa) |
| **Nextclade 3.23.0** | `RLGL*AIPEVVRRLFWRPRCRGRG` (24 aa, internal stop at position 5) |

Independent arithmetic check (`scratch/nc-audit`, reference read straight from the FASTA):

```
correct   rc(A+B)     = MQRPRPPRPLSYSRSSEEAFLEA*      <- equals NCBI NP_043122.1 exactly
nextclade rc(A)+rc(B) = RLGL*AIPEVVRRLFWRPRCRGRG      <- equals Nextclade's output exactly
```

A second, independent confirmation on a geminivirus (`NC_001439.1`, Rep `NP_040770.1`,
`CDS 1592..2653 . - 0`, genome 2647 nt) gives the same clean split: `rc(A+B)` reproduces the RefSeq
protein character-for-character, `rc(A)+rc(B)` reproduces Nextclade's output character-for-character.

## Scope — this is not one record

Method: pulled every RefSeq nucleotide record for 14 predominantly-circular virus families
(Polyomaviridae, Papillomaviridae, Circoviridae, Anelloviridae, Geminiviridae, Genomoviridae,
Nanoviridae, Microviridae, Inoviridae, Hepadnaviridae, Smacoviridae, Redondoviridae,
Bacilladnaviridae, Alphasatellitidae) = **2,426 sequences**, fetched their NCBI GFF3, and flagged
every CDS with `strand == '-'` and `max(end) > landmark length`.

**31 such CDSes in 29 distinct RefSeq genomes.** All 31 were rebuilt as Nextclade datasets and
compared against their RefSeq protein:

| outcome | count |
|---|---|
| **wrong protein, silently** | **26** |
| empty / misnamed garbage translation | 3 |
| whole dataset aborted with an error | 2 |
| **correct** | **0** |

Representative failures (Nextclade vs RefSeq, first 24 aa):

```
NC_001669.1  SV40           NP_043122.1  stops=1   nc=RLGL*AIPEVVRRLFWRPRCRGRG  ref=MQRPRPPRPLSYSRSSEEAFLEA
NC_001439.1  geminivirus    NP_040770.1  stops=1   nc=PPQRFRVQSKNYFLTYPRCTIPKE  ref=MPPPQRFRVQSKNYFLTYPRCTIP
NC_001412.1  geminivirus    NP_040557.1  stops=36  nc=XASY*KISYSSKKHISYISSVFSF  ref=MKVVLIYIILQYSNRYVNMLSHVI
NC_001934.1  geminivirus    NP_047237.1  stops=25  nc=GFVLY*SQKLFPYVSSMLY*QRRS  ref=MPRKGSFSIKAKNYFLTYPQCSIS
NC_001507.1  geminivirus    NP_077735.1  stops=13  nc=QNGFK*MPKIIFLHILSAPCPKKN  ref=MPSHPKRFQINAKNYFLTYPQCSL
NC_001936.1  geminivirus    NP_047243.2  stops=12  nc=*LPETYS*LIQGAMFPKKKFLRCF  ref=MPRNPNSFRLTARNIFLTYPRCDV
NC_002555.1  geminivirus    NP_066371.1  stops=1   nc=SATRRFQIKAKNYFLTYPKCSISK  ref=MPSATRRFQIKAKNYFLTYPKCSI
NC_023868.1  CRESS virus    YP_009021846 stops=4   nc=CPHLVT*RGRSV*VYMCYAVSITA  ref=MPSPRDLKGAVRLGIYVLRCLYNG
NC_007189.1  phage          YP_257146.1  stops=6   nc=SMSCTERSVIRSPTSCWRASSVMV  ref=MAVDRARFRMAVEGGAGGFSPLSP
NC_003327.2  phage          NP_542351.1  stops=6   nc=WGFRCL*NFRFWEFYQ*IEAK*QR  ref=MLIKLPLLGVLSMNRSEMTKNFVF
```

Note the severity gradient. Cases like `NC_001439.1` and `NC_002555.1` are the **most dangerous**:
the protein is only subtly wrong (the wrapped piece is appended instead of prepended, so the start
methionine is gone and a few residues are relocated) and carries just one stop — it looks plausible
enough to pass a casual eye and any QC that only counts internal stops.

Full machine-readable list: `scratch/nc-audit/hot31.tsv`.

## Independent oracle confirmation — the input is not ambiguous

The only oracle used above is NCBI's own RefSeq protein record. To rule out "the GFF3 is ambiguous
and Nextclade's reading is merely different", a **separate, independently written ~90-line
GFF3+FASTA→protein script** (`scripts/gff3_oracle.py`, from the companion oracle investigation) was
run on the *same* GFF3 + FASTA files Nextclade was given:

| | result on the 31 cases |
|---|---|
| independent oracle vs RefSeq protein | **29 / 31 exact** |
| Nextclade vs RefSeq protein | **0 / 31 exact** |

Full table: `data/oracle_vs_nextclade_31.txt`. The two the oracle also misses are the two
pathological "segment entirely past the landmark" records (`NC_027792.1`, and one CDS of
`NC_039069.1`) — the genuinely hard ones.

**The information needed to produce the correct protein is fully present in the GFF3 + FASTA that
Nextclade receives.** Ninety lines of Python get 29 of 31 right; Nextclade gets none.

## Cross-tool context — who else gets this wrong, and who gets it right

From the companion investigation
`../2026-09-15-gff3-protein-oracles.md` (tools installed and run, not inferred):

| tool | SV40 `NP_043122.1` (truth: 23 aa `MQRPRPPRPLSYSRSSEEAFLEA`) |
|---|---|
| **`table2asn`** (NCBI's own submission engine) | **23 aa exact ✅** (7/7 on all of SV40, incl. the 708-aa spliced large T) |
| independent `gff3_oracle.py` | **23 aa exact ✅** (7/7) |
| Nextclade 3.23.0 | `RLGL*AIPEVVRRLFWRPRCRGRG` (24 aa) ❌ |
| gffread 0.12.9 | `RLGL.AIPEVVRRLFWRP` (18 aa — same wrong prefix, then truncated) ❌ |
| AGAT | `RLGL*AIPEVVRRLFWRP` (18 aa, identical to gffread) ❌ |

So the out-of-range circular idiom is a **widespread blind spot** — gffread and AGAT do not handle it
either (they simply clip to the in-range part). That is context, not an excuse: NCBI's own
`table2asn` handles it correctly, `gt gff3validator` is the only tool that actually *reads*
`Is_circular` (accepting out-of-range coordinates when set, erroring when not), and **Nextclade is
the only one of these that documents circular origin-crossing support**. Nextclade also already gets
the plus-strand case right, so it is one strand-aware sort away from being correct.

Two ready-made hooks for a fix:
* `table2asn` emits a dedicated diagnostic for exactly this shape:
  `SEQ_FEAT.SeqLocOrder — Intervals out of order in SeqLoc`, fired on every origin-spanning CDS.
* NCBI's **VADR** `v-build.pl`, run on circular HBV, normalises the wrap into explicitly ordered
  segments: `coords:"2309..3182:+,1..1625:+"` — i.e. exactly the internal representation Nextclade's
  `split_circular_cds_segments` is trying to build, with the ordering made explicit.

## Positive control — plus-strand circular works

Hepatitis B (`NC_003977.2`), the very example Nextclade's own docs cite for circular support, is
**correct**. All three of its origin-crossing CDSes match their RefSeq proteins exactly:

| CDS | Nextclade | RefSeq | |
|---|---|---|---|
| `YP_009173866.1` polymerase (`2309..4807`) | 833 aa | 832 aa + stop | ✅ |
| `YP_009173869.1` preS1 (`2850..4019`) | 390 aa | 389 aa + stop | ✅ |
| `YP_009173870.1` preS2 (`3174..4019`) | 282 aa | 281 aa + stop | ✅ |

So the circular machinery is sound; it is specifically the strand-blind part ordering that is broken.

Worth stating in the upstream issue, because it is to Nextclade's credit: on this same HBV
polymerase, **gffread and AGAT both return 291 aa against a truth of 832** — a silent 65 %
truncation — and `BCBio.GFF`/`gffutils` mangle it further. Nextclade is the *only* GFF3 consumer
benchmarked that gets plus-strand circular right. The ask is to extend that to the minus strand,
not to build it from scratch.

## Suggested upstream framing

> **Minus-strand CDS crossing the origin of a circular genome is translated in the wrong order**
> `split_circular_cds_segments` (`cds.rs:242`) splits an origin-crossing segment into parts ordered
> by ascending genomic coordinate regardless of strand. Since `extract_cds_from_ref`/`_from_aln`
> reverse-complement each part independently and concatenate in order, a minus-strand wrap yields
> `revcomp(A) ++ revcomp(B)` instead of `revcomp(A ++ B)`.
> Repro: SV40 `NC_001669.1` with its unmodified RefSeq GFF3 — Nextclade gives
> `RLGL*AIPEVVRRLFWRPRCRGRG` where `NP_043122.1` is `MQRPRPPRPLSYSRSSEEAFLEA`.
> I scanned 2,426 circular-virus RefSeqs: 31 CDSes hit this, 31/31 produce a wrong or missing
> protein, including the Rep/AC1 replication protein of ~25 geminiviruses. Plus-strand wraps (HBV)
> are unaffected. Fix: order the wrap parts by translation order (`WrappingEnd` first for `-`).

---

# Finding 2 — CDS segments concatenated in GFF row order

**Severity: Critical, but currently latent in NCBI-derived data.** Same root cause family as #1:
segment order is never derived from strand + coordinates.

`Cds::from_feature_group` walks `feature_group.features.iter()` in **file order**
(`packages/nextclade/src/gene/cds.rs:51-53`) and accumulates `range_local` in that order
(`cds.rs:58,67,84`). `extract_cds_from_ref` (`extract.rs:57-69`) then concatenates in that order.
Nextclade therefore requires the rows of a multi-segment CDS to be listed in **5'→3' translation
order** — ascending for `+`, **descending for `-`**. The requirement is undocumented.
The bug is strand-agnostic: a plus-strand CDS with descending rows breaks identically.

## Real-data reproducer — HSV-1 RL2 / ICP0

```sh
cd /tmp && curl -sL "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=NC_001806.2&rettype=fasta&retmode=text" -o hsv1.fa
curl -sL "https://eutils.ncbi.nlm.nih.gov/sviewer/viewer.cgi?db=nuccore&report=gff3&id=NC_001806.2&retmode=text" -o hsv1.gff3
curl -sL "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id=YP_009137133.1&rettype=fasta&retmode=text" -o rl2.faa
# keep the region record plus the RL2 gene/mRNA/CDS records
awk -F'\t' 'NF>=9 && ($3=="region" || ($9 ~ /HHV1gp00p17/ && ($3=="gene"||$3=="mRNA"||$3=="CDS")))' hsv1.gff3 > rl2.rows

for mode in ncbi tabixsort; do
  mkdir -p hsv-$mode && cp hsv1.fa hsv-$mode/reference.fasta
  cat > hsv-$mode/pathogen.json <<'JSON'
{"schemaVersion":"3.0.0","files":{"genomeAnnotation":"genome_annotation.gff3","pathogenJson":"pathogen.json","reference":"reference.fasta"},"attributes":{"name":"hsv"}}
JSON
  if [ $mode = ncbi ]; then
    { echo '##gff-version 3'; grep -vP '\tCDS\t' rl2.rows; grep -P '\tCDS\t' rl2.rows; } > hsv-$mode/genome_annotation.gff3
  else   # the universally-recommended tabix prep
    { echo '##gff-version 3'; grep -vP '\tCDS\t' rl2.rows; grep -P '\tCDS\t' rl2.rows | sort -k4,4n; } > hsv-$mode/genome_annotation.gff3
  fi
  micromamba run -n loculus-nextclade nextclade3 run --input-dataset hsv-$mode --output-all out-$mode hsv-$mode/reference.fasta 2>/dev/null
  echo "== $mode: $(grep -v '>' out-$mode/nextclade.cds_translation.YP_009137133.1.fasta | tr -d '\n' | cut -c1-50)"
done
```

| input | Nextclade RL2 | internal stops | verdict |
|---|---|---|---|
| NCBI GFF3 as downloaded (rows **descending**) | `MEPRPGASTRRPEGRPQREPAPDVWVFPCDRDLPDSSDSEAETEVGGRGD…` | 0 | **exact match** to `YP_009137133.1` |
| same file after `sort -k4,4n` | `QTTYRPPPAGRPAPPHAEAPPRPP*RAGRLTQPPSRPRLGQRPPRRPSGH…` | **15** | **garbage** |

`gffread -g … -y` returns the correct 775-aa protein for **both** orderings.
**Nextclade emits no warning:** `results[0].warnings == []`, `qc.stopCodons == null`,
`qc.overallStatus == "good"`.

## How latent is it, exactly?

* **Official Nextclade datasets: all 106 downloaded and swept — 0 affected.** All 26 multi-segment
  CDSes are in correct translation order.
* **Real RefSeq viral data: 463 minus-strand multi-row CDSes across the 2,426 circular-virus scan —
  0 currently in ascending order.** NCBI's `annotwriter` emits minus-strand CDS rows descending.
* So the bug is a **loaded gun with the safety on**, and these are the things that take the safety off:
  1. **`sort -k1,1 -k4,4n`** — the standard tabix/IGV/JBrowse preparation. Verified to break HSV-1.
  2. **`gffread -o out.gff3`** — verified: gffread normalises minus-strand CDS rows to **ascending**.
  3. Any coordinate-sorted database dump, GTF→GFF3 conversion, or hand-assembled annotation.
### DIY conversion paths (for a virus with no existing dataset)

Tested, since this is how a new dataset gets built:

* **GenBank stores `join()` parts in translation order** — verified on HSV-1 RL2, whose GenBank
  location is `join{[124055:124112](-), [122623:123290](-), [120883:122487](-)}`, i.e. **descending**
  for the minus strand. So a GenBank→GFF3 converter that *preserves* part order is safe for Nextclade;
  one that sorts by coordinate is not.
* **`bcbio-gff` (Biopython's GFF writer) silently collapses a multi-part CDS into one row.** The same
  RL2 feature comes out as a single `120884..124112` CDS — introns included, 3,229 nt. Nextclade then
  rejects it with the divisible-by-3 error, so this fails loudly rather than silently; but the
  annotation is already wrong before Nextclade sees it. Do not build datasets this way.
* **`gffread -o`** reorders minus-strand CDS rows to ascending (breaks Nextclade silently, above) **and**
  strips `ID` from CDS rows (Finding 4b, breaks Nextclade loudly). Not usable as a normaliser here.

* Concrete latent examples in shipped/real data: `nextstrain/herpes/vzv/NC_001348` CDS
  `cds-NP_040165.1` (minus, 2 segments) in the **official dataset list**; and the large T antigen of
  every polyomavirus — SV40 `NP_043127.1`, BK `YP_717940.1`, JC `NP_043512.1`,
  Merkel cell `YP_009111421.1`, KI `YP_001111259.1` — all minus-strand 2-segment spliced CDSes.

## Spec position

The **full** GFF3 v1.26 text (all 60,468 bytes, read directly) contains **no section on ordering,
sorting, or tabix whatsoever**. A multi-line feature is defined purely by the shared `ID`:

> "In the case of discontinuous features (i.e. a single feature that exists over multiple genomic
> locations) the same ID may appear on multiple lines."
> "All lines that share an ID must collectively represent a single feature."

and reading direction comes from the strand column:

> "the 5' end for CDS features on the plus strand is the feature's start and and the 5' end for CDS
> features on the minus strand is the feature's end."

The spec's own canonical-gene example is not coordinate-sorted within its exon block, and the `###`
directive exists precisely because forward references are legal. Row order carries no meaning.

INSDC is the opposite: `join(2004..2195,3..20)` lists intervals in 5'→3' translation order, and
*forbids* out-of-range coordinates ("Base locations beyond the range of the presented sequence may
not be used in location descriptors"). A tool consuming GFF3 must derive order from strand +
coordinates; a tool consuming INSDC may trust interval order. Nextclade applies the INSDC rule to
GFF3 input.

---

# Finding 3 — Panic when annotation coordinates exceed the reference FASTA length

**Severity: High.** A Rust `panic`, not a `Result` — so it also kills `nextclade-web` (WASM) and any
embedding library.

```
The application panicked (crashed).
Message:  index out of bounds: the len is 152 but the index is 152
Location: packages/nextclade/src/align/gap_open.rs:37
```

`get_gap_open_close_scores_codon_aware` allocates `ref_seq.len() + 2` (`gap_open.rs:21`) and then
writes `gap_open_close[i]` for every `i` in each segment's reference range (`gap_open.rs:33-40`),
unchecked. **Nothing anywhere validates annotation coordinates against `ref_seq.len()`.**
The only bounds check, `validate_segment_bounds` (`cds.rs:312`), compares against the *landmark
feature's declared range* and is skipped entirely when no landmark resolves (`cds.rs:61-65`).

Four reproducers, all panicking:

| condition | why validation misses it |
|---|---|
| no `region` record at all | `segment.landmark == None` → check skipped |
| `region` present but its `ID` ≠ the CDS row's `seqid` | landmark unresolved (`feature_tree.rs:204-212`) |
| **`region 1 200` but `reference.fasta` is 150 nt** | passes the landmark check; nobody checks the FASTA |
| CDS entirely past the reference end | same (panics at `gap_open.rs:35`) |

The third is the realistic one: **a `##sequence-region`/`region` record that disagrees with the
FASTA is sufficient**, which happens whenever an annotation is paired with a trimmed or
differently-versioned reference.

```sh
mkdir -p /tmp/pastend && cd /tmp/pastend
python3 -c "
import random; random.seed(11)
s=[random.choice('ACGT') for _ in range(150)]
for i,c in enumerate('ATGAAATTGTGGCATCCGAAA'): s[129+i]=c
open('reference.fasta','w').write('>ref\n'+''.join(s)+'\n')"
printf '##gff-version 3\n##sequence-region ref 1 200\nref\tRefSeq\tCDS\t130\t153\t.\t+\t0\tID=cds-T;Name=T;gene=T\n' > genome_annotation.gff3
cat > pathogen.json <<'JSON'
{"schemaVersion":"3.0.0","defaultCds":"T","files":{"genomeAnnotation":"genome_annotation.gff3","pathogenJson":"pathogen.json","reference":"reference.fasta"},"attributes":{"name":"pastend"}}
JSON
micromamba run -n loculus-nextclade nextclade3 run --input-dataset . --output-all out reference.fasta
```

For contrast, when a landmark *is* present and consistent the error is clean and good:
`"Feature end at position 155 is outside of landmark feature bounds: 1..151."`

**Is the input valid?** Mixed, and it does not matter. Per spec, when `##sequence-region` is given
features must be contained in it *unless* the landmark is `Is_circular` — so these files are invalid
GFF3. But a panic is a bug regardless; the correct behaviour is the `make_error!` that already
exists.

## Finding 3b — `start > end` panics, making existing error handling dead code

`validate_segment_bounds` has a well-worded error for `start > end` (`cds.rs:313-320`) that **can
never fire**: `Range::new`/`from_usize` assert first (`coord/range.rs:33,39,49` — real `assert!`,
live in release builds).

```sh
printf '...\nref\tRefSeq\tCDS\t100\t90\t.\t+\t0\tID=cds-Z;Name=Z\n' > genome_annotation.gff3
# -> assert!( begin <= end ) with expansion: 99 <= 90 ; panic at coord/range.rs:33
```

---

# Finding 4 — `chunk_by` groups only consecutive rows

**Severity: High.** `packages/nextclade/src/features/feature_tree.rs:229` uses itertools `chunk_by`,
which splits on key *changes* like `uniq` — not a full group-by. GFF3 places no adjacency
requirement on lines sharing an `ID`, and Nextclade's own docs say *"`CDS` segments are joined if
they have the same `ID`"* with no adjacency caveat.

## Reproducer A — the ordinary `exon, CDS, exon, CDS` layout (hard failure)

One block per exon, rather than all exons then all CDSes. Emitted by many GTF→GFF3 converters; plainly valid GFF3.

```sh
cat > genome_annotation.gff3 <<'GFF'
##gff-version 3
##sequence-region ref 1 195
ref	RefSeq	region	1	195	.	+	.	ID=ref;Name=ref
ref	RefSeq	gene	61	101	.	+	.	ID=gene-A;Name=A
ref	RefSeq	mRNA	61	101	.	+	.	ID=rna-A;Parent=gene-A;Name=A
ref	RefSeq	exon	61	69	.	+	.	ID=exon-A1;Parent=rna-A;Name=A
ref	RefSeq	CDS	61	69	.	+	0	ID=cds-A;Parent=rna-A;Name=A
ref	RefSeq	exon	90	101	.	+	.	ID=exon-A2;Parent=rna-A;Name=A
ref	RefSeq	CDS	90	101	.	+	0	ID=cds-A;Parent=rna-A;Name=A
GFF
```

* **Nextclade:** `CDS names are expected to be unique, but found duplicate names: 'A'`
  (`gene_map.rs:208`) — the whole dataset fails to load. The guard fires on the *symptom*, not the
  cause, and the message gives no hint that row adjacency is the issue.
* **gffread:** `>rna-A  MKLACH` — correct.

## Reproducer B — silent corruption when `Name` attributes differ

With `Name=A_part1` / `Name=A_part2` on the two `ID=cds-A` rows, Nextclade silently emits **two**
CDSes, `A_part1 = MKL` and `A_part2 = ACH*`, instead of one `MKLACH*`. No warning.

## Finding 4b — grouping by `ID` only, never `Parent`

gffread's own GFF3 output puts no `ID` on CDS lines, only `Parent`:

```
NC_001806.2	RefSeq	CDS	120884	122487	.	-	2	Parent=rna-HHV1gp00p17
```

Nextclade falls back to `name = "Feature #{index}"` → `id = name` (`features/feature.rs:55-62`), so
each row becomes its own CDS:
`Length of a CDS is expected to be divisible by 3 … CDS 'Feature #1' is 1604`.
**Nextclade cannot read `gffread -o` output for any spliced CDS.** The spec does require `ID` on
multi-line features, so this is class (b) — but gffread, gffutils and Biopython all group by
`Parent` when `ID` is absent, and at minimum the error should name the file/line and say an `ID` is
needed.

---

# Finding 5 — GFF3 phase column ignored on input, overwritten on output

**Severity: High for 5'-partial CDSes; invisible for complete ones.**

```rust
// packages/nextclade/src/gene/cds.rs:58-59
let range_local = Range::from_usize(begin, begin + feature.range.len());
let phase = Phase::from_begin(range_local.begin)?;   // derived, column 8 never read
```

`Phase::from_begin` is itself correct — `(3 - begin % 3) % 3` (`gene/phase.rs:19-28`), the GFF3
convention — so for a *complete* CDS derived == declared. (Verified on real data: ebola-sudan
`cds-YP_009246341.1` declares `0,1` and Nextclade derives `0,1`; HSV-1 RL2 declares `0,0,2` and
re-emits `0,0,2`.) The bug is that the **first** segment is always assumed phase 0.

```sh
# CDS 61..90 declaring phase 2 (legitimately 5'-truncated); true start is base 63
printf '...\nref\tRefSeq\tCDS\t61\t90\t.\t+\t2\tID=cds-P;Parent=rna-P;Name=P\n' > genome_annotation.gff3
```

| | result |
|---|---|
| **expected** (and gffread) | `MKLACHWHR` |
| **Nextclade** | `K*NWPVIGIG` — wrong frame, immediate internal stop, no warning |

`nextclade.json` shows `"phase": 0, "frame": 0`. The output is lossy too: `nextclade.gff` re-emits
phase `0` (`io/gff3_writer.rs:106`) and `nextclade.tbl` omits `codon_start` entirely, which is only
written when the derived phase ≠ 0 (`io/genbank_tbl.rs:119-127`). A partial CDS round-tripped
through Nextclade loses its frame.

The spec is unusually explicit about why phase exists:

> "The phase is REQUIRED for all CDS features."
> "CDS features MUST have have a defined phase field. Otherwise it is not possible to infer the
> correct polypeptides corresponding to partially annotated genes."

There is **no** rule that the first CDS line must be phase 0. The machinery to carry a non-zero
starting phase already exists and works for alignment-derived truncation
(`run/nextclade_run_one.rs:660-663`, `seg.phase.shifted_by(left_truncation)`) — only the *input*
phase is dropped.

*Real-world exposure note:* no official dataset declares a non-zero first phase today, but **76 CDS
rows across 8 official datasets declare phase `'.'`** (e.g. `community/itps/zikav`, `community/neherlab/hiv-1/hxb2`,
the three `enpen/enterovirus/*`, `nextstrain/mumps/genome`), which the spec forbids: *"The phase is
REQUIRED for all CDS features."* Nextclade derives phase anyway, so this is currently harmless — but it
means the declared phase could not be honoured for these datasets even if Finding 5 were fixed.

---

# Finding 6 — a bare `gene` with no CDS child and length ∤ 3 rejects the entire dataset

**Severity: High. Active on real RefSeq data.**

Nextclade has a compatibility hack: *"if there are no CDS records, we pretend that each gene record
implies a CDS with one segment and one protein"* (`packages/nextclade/src/gene/cds.rs:136-203`,
`Cds::from_gene`). The synthesised CDS is then subjected to the divisible-by-3 check
(`gene_map.rs:177`), and failing it aborts the whole load.

Real case — `NC_003866.1` (Cabbage leaf curl virus satellite A), unmodified NCBI RefSeq GFF3:

```
gene  33..1567   1535 nt  -  Name=AC1   ID=gene-CbLCVsAgp2     <- no CDS child
gene  1567..2616 1050 nt  -  Name=CbLCVsAgp1
CDS   1567..2616 1050 nt  -  Name=NP_620884.1
```

```
Error: Length of a CDS is expected to be divisible by 3, but the length of CDS 'AC1' is 1535
       (it consists of 1 fragment(s) of length(s) 1535). This is likely a mistake in genome annotation.
Location: packages/nextclade/src/gene/gene_map.rs:177
```

A gene record that carries no CDS and whose length happens not to be a multiple of 3 — extremely
common for overlapping-ORF viral annotations — makes the dataset unusable. The compat hack should
not synthesise a CDS from a gene whose length is not a multiple of 3; it should skip it, or warn.

Related, same path: in `NC_039069.1` two `gene` records with `gene_biotype=other` and no CDS child
get gene-derived CDSes, so their translations are emitted under the **locus tag** (`D1U68_gp2`,
`D1U68_gp3`) rather than the protein accession — and, being minus-strand origin-crossing, they are
also wrong (Finding 1). A consumer looking for `YP_009508858.1` simply finds nothing, with exit 0
and no warning.

---

# Finding 7 — wrap segment lying entirely past the landmark end

**Severity: Medium. Active on real RefSeq data.** Two real records where a minus-strand CDS's
5'-most piece begins *after* the landmark end.

**`NC_027792.1`** (genome 1895 nt), a real CRESS-virus RefSeq whose Rep is both spliced and
origin-crossing:

```
CDS  1904  2024  .  -  0  ID=cds-YP_009163920.1;part=1;product=putative spliced replication initiation protein
CDS  1042  1838  .  -  2  ID=cds-YP_009163920.1;part=2
```

```
Genome annotation is invalid: In genomic feature 'YP_009163920.1':
Feature start > end: 1904 > 1896. Please report this to dataset authors.
```

**The error is misleading**: `1896` appears nowhere in the file. `split_circular_cds_segments` sets
`segment.range.end = clamp_max(segment_end, landmark_end)` (`cds.rs:264`) without touching
`range.begin`, producing the inverted range `(1903, 1895)`; `validate_segment_bounds` then reports
it as a defect in the user's data and tells them to complain to the dataset authors.

**`NC_001466.1`** (genome 2750 nt) has the same shape (`CDS 2751..2876` + `1864..2748`, minus
strand). Here the clamp yields a **zero-length** first part rather than an inverted one, so
validation passes and Nextclade emits an **empty translation** for a 336-aa protein.

---

# Finding 10 — `transl_except` is parsed but never applied — a shipped dataset ships a wrong protein

**Severity: Medium. Active in an official Nextclade dataset today.**

`transl_except` *is* read — but only as a display/metadata string, collected into the feature's
`exceptions` list (`packages/nextclade/src/io/gff3_reader.rs:126-136`). Nothing under
`packages/nextclade/src/translate/` ever consults `exceptions`, so it has no effect on translation.

The official dataset **`community/neherlab/hiv-1/hxb2`** carries the attribute in its own annotation:

```
NC_001802.1  RefSeq  CDS  8343  8963  .  +  0  Name=nef;...;transl_except=(pos:8712..8714%2Caa:Trp);...
```

HXB2 Nef has a readthrough codon that INSDC records as Trp. `(8712 - 8343) / 3 = 123`, so the
affected residue is amino acid **124**. Nextclade's output:

```sh
micromamba run -n loculus-nextclade nextclade3 run \
  --input-dataset community_neherlab_hiv-1_hxb2 --output-all out reference.fasta
# nef: length 207, internal stop at aa 124, context  HTQGYFPD*QNYTPGPG
```

`nef` is the **only** CDS with an internal stop in that dataset — so this is a visible, isolated
artefact in shipped output, and the information needed to fix it is present in the dataset's own
GFF3. Nextclade already has the parsing; it just never uses it.

This is the one `transl_except` case across all 106 official datasets, so the fix is cheap and the
blast radius is tiny. Minimum viable behaviour: apply it, or emit a warning naming the CDS and
position rather than silently producing a stop codon mid-protein. (Note the companion investigation
found that NCBI's *sviewer* GFF3 export drops `transl_except` entirely — so it is unrecoverable for
some inputs. It is present here, which is what makes this actionable.)

# Finding 8 — circular round-trip is lossy (Low)

* **`Is_circular` is dropped** from the exported `region` record: `out/nextclade.gff` writes
  `ref nextclade region 1 150 . . . Name=ref;seq_index=0;ID=ref`. Re-reading Nextclade's own output
  therefore yields a non-circular multi-segment CDS (`io/gff3_writer.rs:111+`).
* **Phase is not recomputed for split wrap parts.** `split_circular_cds_segments` rewrites
  `range_local` (`cds.rs:264-265, 285-288`) but never `phase`, so the one-row spec form exports both
  parts with phase `0` where the second should be `1`. (The equivalent two-row input exports `0,1`
  correctly.)
* **`gene` range of a wrapping CDS spans the whole genome.** `Cds::start()`/`end()` are `min`/`max`
  over segments (`cds.rs:213-219`), so an origin-crossing CDS reports `0..len` and the exported GFF3
  claims `gene 1 <genome length>`. Defensible as a bounding box; still claims the gene covers
  everything.

---

# Finding 9 — smaller observations

* **9a — mixed-strand segments.** A CDS with `+` and `-` segments writes
  `nextclade.cds_translation.M.fasta` containing `MKLSMTG` and **then** fails with
  `Expected exactly one value, but found: 2` (`utils/iter.rs:17`, `single_unique_value` over
  strands), leaving partial output on disk. Should be rejected at annotation load with a message
  naming the feature and the two strands.
* **9b — strand `?` and `.`** are silently treated as `+` on a CDS. `?` is explicitly legal GFF3
  ("features whose strandedness is relevant, but unknown"); for a CDS this deserves a warning.
* **9c — `transl_table` ignored.** `transl_table=2` has no effect; the standard code is always used
  (mitochondrial `TGA` → `*` not `W`). gffread does the same. Low priority for viruses, but worth
  documenting as unsupported.

---

# Verified correct — no action needed (class (c))

These were tested hard and are genuinely fine. Reporting them so nobody re-hunts them.

## Overlapping CDS segments (ribosomal slippage / RNA editing) — correct, and better than gffread

Real ebola-sudan (`NC_006432.1`) annotates GP as `5998..6882` + `6882..8027`, overlapping by one
base at the RNA-editing site, `exception=RNA editing`:

| CDS | segments | nt | aa | internal stops | terminal stop |
|---|---|---|---|---|---|
| GP | `5998..6882` + `6882..8027` (1-base overlap) | 2031 | 677 | 0 | yes |
| ssGP | `5998..6881` + `6883..6955`, phases `0,1` | 957 | 319 | 0 | yes |
| sGP | `5998..7116` | 1119 | 373 | 0 | yes |

All nine CDSes translate cleanly. **gffread crashes on this file** (`double free or corruption`,
`malloc(): invalid size`) — the known gffread bug where CDS segments are deliberately not merged
while exons are, so `covlen` under-sizes `GMALLOC(spliced, covlen+1)` (gffread issue #121). On this
edge case Nextclade is more robust than the reference implementation.

This is also exactly the layout the GFF3 spec's **Pathological Cases → Programmed frameshift**
section prescribes (from the part of the spec an earlier partial fetch had missed):

```
chrX  . CDS   XXXX   YYYY .  +  0 ID=cds01;Parent=tran01
chrX  . CDS   YYYY-1 ZZZZ .  +  0 ID=cds01;Parent=tran01
```
> "The CDS segment that represent the new reading frame will always has a phase of 0 since the
> ribosome is moving and thus redefining the codon."

## Truncated / partial query sequences — correct

Differential self-consistency test over **all 106 official datasets**: for each, the reference plus
9 derived queries (30% 5' trim, 30% 3' trim, 20% both-ends trim, 500-nt internal deletion, 1/3 of
the genome N-masked, and ±1/±2 nt end trims) were translated and every CDS compared position-by-position
against the full-reference translation, treating only `-` and `X` as acceptable differences.

**101 datasets run, 9,823 translation comparisons, 0 mismatches, 0 crashes.**

Spot-checked in detail: a query trimmed by 10 nt at a CDS 5' end reports
`truncation: {"fivePrime": 10}`, `phase: 2` (correctly shifted), translation `---XCHWHPKGF**` —
gaps for missing residues and `X` for the codon straddling the boundary. Correct.

## Also verified correct

* **IUPAC / `N` inside a CDS** → single `X`, frame preserved.
* **Exactly adjacent segments** (zero-length intron) → one contiguous ORF. (gffread silently *merges*
  such exons, changing exon counts.)
* **CDS length not divisible by 3** → clean, informative error naming the CDS and fragment lengths.
* **Unresolvable `Parent`** → clean error listing every offending row (`feature_tree.rs:170-193`).
* **Plus-strand circular wrap** → correct in both the one-row spec form and the two-row form, with
  sensible `wrappingPart` values, and a clean error when the landmark exists but is not circular.

---

# Documentation contract

`docs/user/input-files/03-genome-annotation.md` states:

> "Nextclade supports multi-fragment CDSs which enable the correct translation of complex features
> including programmed ribosomal slippage (e.g. ORF1ab in SARS-CoV-2), **genes crossing the origin of
> a circular genome (e.g. Hepatitis B virus)** and CDS that require splicing (e.g. HIV)."

> "**Almost any syntactically correct spec-compliant GFF3 annotation (e.g. downloaded from Genbank)
> should work.**"

and lists the *only* documented deviations from the spec as:

> "- Names of genes are required to be unique
>  - Names of CDSes are required to be unique
>  - Names of proteins are required to be unique"

> "`CDS` segments are joined if they have the same `ID`, otherwise they are treated as independent."

Findings 1, 2, 4, 5, 6 and 7 are all spec-compliant GFF3 downloaded from GenBank that does **not**
work, and none of them is covered by the documented deviations. The row-order requirement (#2) and
the strand-blind wrap ordering (#1) are undocumented in particular.

---

# Recommended reporting order

1. **Finding 1** — hot, real, silent, 31/31 real RefSeqs, one-line repro against SV40.
2. **Finding 3 (+3b)** — a crash is unambiguous and cheap to fix; file both panics as one
   "annotation bounds are never validated against the reference" issue.
3. **Finding 2** — pair with #1: both are "segment order is never derived from strand+coordinates",
   and one strand-aware sort fixes both. Lead with the `gffread`/`sort -k4,4n` exposure.
4. **Finding 6** — small, real, and it makes a RefSeq genome unusable.
5. **Finding 5** — phase; small and well-specified.
6. **Findings 4 (+4b) and 7** — grouping and wrap-clamp edge cases.
7. **Finding 10** — `transl_except`; one line of real impact in a shipped dataset, cheap to fix.
7. **Finding 8/9** — a single "circular round-trip and error-quality cleanup" issue.

**Findings 1 and 2 share a root cause** — segment order is never derived from strand + coordinates.

## ⚠ Caveat: the obvious fix for Finding 2 would break a case Nextclade currently gets right

A naive "sort segments by `range.begin` (ascending for `+`, descending for `-`)" **regresses the
two-row circular join**, where the wrap is written as two in-range rows sharing an `ID`. Tested:

| `reproducers/` dataset | row order | Nextclade | correct |
|---|---|---|---|
| `circ-2row-translorder` | `140..150`, then `1..4` (translation order) | `MKLW*` | `MKLW*` ✅ |
| `circ-2row-coordsorted` | `1..4`, then `140..150` (coordinate order) | `VNEIV` ❌ | `MKLW*` |

Because Nextclade honours row order, it gets the first one **right** — and the companion
investigation found that *every* coordinate-sorting tool it benchmarked (gffread, AGAT, and its own
reference implementation) gets this form **wrong**, for exactly the reason a naive sort would: the
post-origin fragment sorts first. GFF3 has no way to mark a segment as "biologically first" other
than file order.

So the fix must be **circularity-aware**, not a plain sort: sort in the rotated/extended coordinate
system when the CDS wraps (or when the landmark is `Is_circular` and the segments are non-monotonic
in strand order), and only sort by raw coordinate otherwise. A regression test for both
`circ-2row-*` datasets belongs with any such change.

**Suggested detection predicate**, which also gives a ready-made error case. NCBI's `table2asn`
emits `SEQ_FEAT.SeqLocOrder — "Intervals out of order in SeqLoc"` on exactly this shape, and
the companion investigation verified its **specificity** on SV40, whose single record contains both
shapes:

| SV40 feature | alert |
|---|---|
| `NP_043122.1` — minus-strand **wrap** | **`SEQ_FEAT.SeqLocOrder`** ✅ |
| `NP_043127.1` large T — minus-strand **spliced, no wrap** | none (specificity control) |

and the alert is correctly *suppressed* when the record declares `[topology=circular]` — i.e. it
really means **"these intervals only make sense on a circle."** That is precisely the predicate
Nextclade must evaluate and currently does not:

> when `max(end) > landmark length`, **or** the segments are non-monotonic in strand order:
> if `Is_circular=true`, splice on the circle and reverse-complement **once, at the end**;
> if `Is_circular` is absent, **error** rather than clamp (Findings 3 and 7).

---

# Notes for us (Loculus / Pathoplexus)

* **Finding 1 is a real risk if we ever ship a circular-genome organism** with minus-strand genes —
  geminiviruses, circoviruses, anelloviruses, polyomaviruses, many phages. HBV (plus-strand only) is
  safe. Any CRESS/ssDNA virus is not.
* **Finding 2 is latent in our NCBI-derived annotations — do not run them through `gffread -o` or
  `sort -k1,1 -k4,4n`.** Doing so silently frameshifts minus-strand spliced CDSes.
* **Finding 3** is the likeliest production hit: a `region`/`##sequence-region` disagreeing with the
  reference FASTA length crashes the process rather than erroring.
* **Cheap pre-flight worth adding to any dataset we ship**, all statically checkable from the GFF3
  + FASTA (the sweep script is `scratch/nc-audit/ncds/sweep.py`):
  1. every CDS segment within `len(reference.fasta)`;
  2. multi-row CDSes in descending order when `strand == '-'`;
  3. no minus-strand CDS with `end > landmark length` (Finding 1) — reject or hand-fix;
  4. no bare `gene` without a CDS child whose length ∤ 3 (Finding 6);
  5. all rows of one `ID` adjacent in the file (Finding 4).

---

# Files in this investigation directory

```
README.md                          this report
data/
  circular_minus_results.tsv       Finding 1: all 31 real RefSeq cases, verdict + first 30 aa vs RefSeq
  hot31.tsv                        the 31 minus-strand origin-crossing CDSes (accession, len, protein, shape)
  hot_accs.txt                     the 29 distinct accessions
  circvir_refseq_ids.txt           the 2,426 circular-virus RefSeq GIs that were scanned
scripts/
  collect.py fetch.py scan.py      the 2,426-genome RefSeq scan (Finding 1 scope)
  verify_circ.sh                   build a Nextclade dataset from an NCBI accession and run it
  sweep.py                         static trigger sweep over the 106 official datasets
  trunctest2.py                    differential truncation test (9,823 comparisons)
  names.txt                        the 106 official dataset names
  mkds.py build.py run.sh          synthetic reproducer generators/runner
reproducers/                       28 minimal datasets (reference.fasta + genome_annotation.gff3 + pathogen.json)
```

Every reproducer directory is a complete Nextclade dataset; run any of them with:

```sh
micromamba run -n loculus-nextclade nextclade3 run \
  --input-dataset reproducers/<name> --output-all /tmp/out reproducers/<name>/reference.fasta
```

Large working data not copied here (regenerate with `scripts/`):
`/workspaces/claude-devcontainer/scratch/nc-audit/` (106 official datasets under `ncds/`, the 29 rebuilt
circular-virus datasets under `cv/`, full GFF3 + INSDC specs under `specs/`) and `/tmp/circvir/gffbatch/`
(the 2,426 fetched RefSeq GFF3s).

# Reproducer inventory (working copies)

Under `/workspaces/claude-devcontainer/scratch/nc-audit/`:

* `specs/so-spec/` — full cloned GFF3 v1.26; `specs/FT_current.txt`, `specs/insdc-feature-table.html` — full INSDC v11.4.
* `ncds/` — all 106 official datasets, `sweep.py` (static trigger sweep), `trunctest2.py` (differential truncation test).
* `cv/` — the 29 real circular-virus genomes rebuilt as datasets from NCBI, plus `out-*`/`err-*`; `hot31.tsv`, `hot_accs.txt`.
* `hbv/`, `sv40/` — the positive and negative real-world controls.
* `hsv-ncbi/`, `hsv-tabixsort/`, `hsv-via-gffread/`, `plus-asc/`, `plus-desc/` — Finding 2.
* `circ-nolandmark/`, `nolandmark-match/`, `lenmismatch/`, `pastend/`, `revcoords/` — Finding 3.
* `interleave*/`, `exon-blocks/`, `samedid-diffname/`, `adjacent/` — Finding 4.
* `phase2/` — Finding 5. `circ-spec/`, `circ-2row/`, `circ-lm-notcirc/`, `circ-minus/` — Findings 1, 8.
* `circ-2row-translorder/`, `circ-2row-coordsorted/` — the regression pair for the Finding 2 fix caveat.
* `mixedstrand/`, `strand-q/`, `strand-dot/`, `adjacent-seg/`, `transl-table/`, `iupac/`, `trunc/` — Finding 9 and controls.
* Generators `mkds.py`, `build.py`; runners `run.sh`, `verify_circ.sh`.
* `/tmp/circvir/` — the 2,426-genome scan: `collect.py`, `fetch.py`, `scan.py`, `gffbatch/`.

---

# Companion investigation

`../2026-09-15-gff3-protein-oracles.md` — GFF3+FASTA → protein oracles for viral annotation.
Benchmarks `table2asn`, `gt gff3validator`, VADR, AGAT, gffread and a reference implementation
against SARS-CoV-2, HBV, Ebola, HIV-1, SV40 and 40 geminivirus RefSeqs; includes VADR's full alert
catalogue. Installed envs: `t2a`, `gt`, `vadr`, `bio`. Reproducers in `scratch/nc-audit/oracles/`.

Findings from it that bear on this audit:

* **Nextclade is not alone on the wrap, but it is alone in advertising support for it.** gffread and
  AGAT also mistranslate SV40 `NP_043122.1` (both give the same 18-aa clipped `RLGL*AIPEVVRRLFWRP`);
  `table2asn` and the reference implementation get it exact.
* **Use `table2asn` (env `t2a`) or `scripts/gff3_oracle.py` (env `bio`) as the oracle for circular
  viruses — not gffread.** A GFF3→`.tbl` bridge is provided (`scripts/gff3_to_tbl.py`); end-to-end it
  is 28/28 exact on SARS-CoV-2 + HBV + Ebola and 7/7 on SV40.
* **`gt gff3validator` (env `gt`) is the only tool that reads `Is_circular`** — it accepts
  out-of-range coordinates when the flag is set and correctly errors when it is not. Useful as a
  pre-flight validator for any dataset we ship.
* Two further tool defects found there, relevant because they are in *our* candidate toolchain:
  gffread heap-corrupts (`malloc(): corrupted top size`) on the **unmodified SARS-CoV-2 RefSeq
  GFF3** and still exits 0; AGAT silently merges the ORF1ab overlapping join and emits a 7,096-aa
  protein that matches truth for 4,401 aa then carries **172 internal stops**, also exit 0.
* VADR does not consume or emit GFF3 (`.tbl` only) and has **no** circular support, but its
  `v-build.pl` on HBV normalises the wrap to ordered segments `coords:"2309..3182:+,1..1625:+"` —
  the representation Nextclade should be producing.

## Note on a cross-checked discrepancy

The oracle investigation observed that gffread/AGAT score 207/208 on a 40-genome geminivirus sample —
handling minus-strand *spliced* Rep fine — and suggested Nextclade's ~20 geminivirus failures might
indicate a second, splice-ordering bug. **Checked: there is no second bug.** All but 3 of the 31
failing CDSes here are **single-row** origin-crossing features (`data/hot31.tsv`, column 4), so no
splicing is involved at all. The apparent discrepancy is sample size: that sweep covered 40
geminivirus genomes and found 1 wrap (2.5%); this sweep covered all **818** Geminiviridae RefSeqs and
found 19 (2.3%) — the same rate. Both numbers describe the same single defect.
