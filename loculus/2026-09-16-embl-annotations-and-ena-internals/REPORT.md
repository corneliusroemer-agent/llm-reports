# EMBL annotation files, Nextclade's GFF handling, and what ENA actually does with a submission

Pathoplexus enabled downloadable EMBL annotation files on 2026-09-15. Within minutes every RSV-A
and RSV-B entry on staging was failing. Chasing that one crash ended up mapping three systems: the
flatfile generator in Loculus preprocessing, Nextclade's handling of GFF3 annotations, and the
inside of ENA's submission pipeline.

Machine-generated, reviewed only through the prompts that produced it. Every structural claim below
was verified against source or live data at the time of writing; the sub-reports carry the
`file:line` citations.

## What was wrong

A single line, `embl.py:218`:

```python
qualifiers["codon_start"] = qualifiers.get("codon_start", 0) + 1
```

Nextclade returns GFF3 attributes as **lists**, because GFF3 attributes are multi-valued. RSV's
Nextclade datasets are the ones that carry an explicit `codon_start=1` attribute, so the value
arrived as `["1"]` and the expression became `["1"] + 1`. Every RSV entry — 100 % of them, 45,747
and 37,031 on the two organisms — went to `HAS_ERRORS`, which blocks release.

The tempting fix is wrong. The GFF attribute is **already** 1-based, so unwrapping the list and
keeping the `+ 1` yields `2` and silently frameshifts every RSV CDS. The `+ 1` was written for
Nextclade's 0-based `phase`, which lives on the segment rather than in the attributes and never
arrived at all.

Three further defects surfaced in the same function, all silent:

| defect | effect |
|---|---|
| strand computed, then ignored when translating | 96 of mpox's 179 CDSes translated off the forward strand — nonsense protein |
| spliced CDSes translated per segment, then concatenated | junctions fall mid-codon; influenza M2 came out as `MSLLTEVETYQKRMGVQMQRFK*…` |
| terminal stop kept in `/translation` | INSDC excludes it |

A fourth was found only by building a test for it: because Nextclade lists segments in
**transcription order**, reverse-complementing the *joined* sequence re-reverses them, splicing a
minus-strand CDS back to front. `MKAA` became `A*MK`.

## What this says about the release

Two questions were worth more than the bug itself.

**Did anything reach users?** No. Loculus refuses to adopt a new pipeline version unless everything
that succeeded under the current one also succeeds under the new one, so released counts never
moved. On the preview, though, the guard is vacuous — a fresh database has no prior successes to
protect — so the broken version was adopted there, and RSV sat at **0 released sequences while all
13 other organisms had thousands**, for five days, unnoticed.

**Would ENA have caught it?** Yes, and this is the reassuring part: a wrong `/translation` is a hard
`ERROR` (`CDSTranslator-16`). Only an `X`-only mismatch is silently corrected. So had these records
been submitted, they would have been **rejected, not published wrong**.

## What we learned about Nextclade

Auditing the assumptions turned up bugs in Nextclade itself, on unmodified NCBI RefSeq data.

**Minus-strand CDSes crossing a circular origin are silently mistranslated.** Nextclade computes
`revcomp(A) ++ revcomp(B)` where the answer is `revcomp(A ++ B)`. Across 2,426 circular virus RefSeq
genomes, 31 CDSes qualify: **26 wrong, 3 garbage, 2 abort, 0 correct** — SV40 and the Rep/AC1
replication protein of ~25 geminiviruses. SV40's `NP_043122.1` should be `MQRPRPPRPLSYSRSSEEAFLEA`
and comes out `RLGL*AIPEVVRRLFWRPRCRGRG`, with `warnings: []` and QC `"good"`. HBV, the example
Nextclade's own docs cite for circular support, is correct — the machinery works, only the
strand-blind ordering is broken.

**Segment order follows GFF row order, with no strand-aware sort.** gffread returns the correct
protein whichever order the rows are in; Nextclade does not. It stays latent because NCBI emits
minus-strand rows descending — but `sort -k1,1 -k4,4n` (standard tabix prep) or `gffread -o` both
activate it and silently frameshift HSV-1 RL2 into 15 internal stops. This corrupts
`alignedAminoAcidSequences` too, not just the flatfile, so it is not a download-only concern.

**Also:** an annotation running past the reference length panics rather than erroring; the GFF3
`phase` column is ignored, so a legitimately 5'-partial CDS makes a dataset unloadable; and
`transl_table` is ignored. None currently affects Pathoplexus — all its organisms are linear and
plus-strand where it matters — but each is a trap for a future dataset.

Nextclade is not uniformly worse: on ebola-sudan's overlapping RNA-editing segments it is correct
where **gffread crashes** with a double free.

## What we learned about ENA

The largest finding, because it answers something long misunderstood.

**webin-cli never submits the record it builds.** It constructs one in memory purely to decide
pass/fail, discards it, and uploads your files byte-for-byte. The real construction happens
server-side, on the same library, with live database connections. The local run is a dry run.

That library is `sequencetools`, and it runs in two modes against **two Oracle databases** —
`ENAPRO` (the EMBL-Bank sequence archive) and `ERAPRO` (the submission registry). The source says so
outright: *"Database connections(ENAPRO,ERAPRO) must be given when validating submission
internally"*, guarded by `if (!isWebinCLI)`. ENA's internal loader `putff` is named in the scope
annotations. Every submitter has ENA's production DAO in their jar; it is simply never wired to a
connection.

**Your source feature is discarded and rebuilt from the BioSample.** In genome context the reader
drops the source feature's qualifiers entirely — the same file parsed two ways gives `source=4q`
versus `source=0q`, while `gene` and `CDS` keep everything. The mapping that replaces it is
hardcoded Java with a **15-qualifier allow-list**; anything outside it is dropped without a message.
Attribute names are ENA sample-checklist spellings, matching is case-sensitive for the geo fields
and case-insensitive for the rest, and `/host` and `/lat_lon` are reachable **only for SARS-CoV-2**,
via a literal taxid check. Traced end to end: of 18 attributes on a real Pathoplexus sample, 17
contributed nothing, and the prediction matches the published record exactly.

The practical consequence is that enriching the submitted flatfile is mostly pointless — the
metadata belongs on the BioSample. **Annotations are the exception: `gene` and `CDS` survive**, ENA
adds `/locus_tag` and a `/transl_table` derived from the sample's taxonomy, and illegal qualifiers
error rather than vanishing.

**ENA's documentation says data is "validated in full" client-side. It is not** — a dozen checks are
database-gated, and there is no client-side signal that a subset was taken. `webin-cli` exiting 0 is
not success. Worse, the report file is written *only* when validation fails, so every warning and
auto-fix is invisible to the submitter.

## Contents

| | |
|---|---|
| [`01-nextclade-audit/`](01-nextclade-audit/) | Nextclade robustness audit with runnable reproducers, plus the oracle tooling used to check it (gffread, table2asn, VADR, ENA's own validator) |
| [`02-ena/`](02-ena/) | why ENA accepts an invalid flatfile, how it builds the record it publishes, what its library reveals about ENA's internals, and prior art on flatfile qualifiers |

## Caveats

The server side of ENA is **inferred from a client-side library**, not observed; the sub-reports tag
claims `[PROVEN]`/`[IMPLIED]`/`[INFERRED]`/`[GAP]` accordingly. No live INSDC record provably
produced from an annotated genome-context flatfile was found, so "annotations survive" rests on
ENA's own regression fixtures rather than an end-to-end example. All ENA interaction was validation
only against the test service; nothing was submitted.
