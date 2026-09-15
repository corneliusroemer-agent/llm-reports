# EMBL flatfile source-feature qualifiers — prior art in Loculus / Pathoplexus

Date: 2026-09-15. Read-only research (no issues opened, edited or commented; nothing pushed).

Scope searched:
- `loculus-project/loculus` (issues + PRs, open and closed)
- `pathoplexus/pathoplexus`
- `pathoplexus/ena-submission` (the approvals/ops repo — this is where the real ENA pain lives)
- `loculus-project/ena-submission` (dead mirror, last push 2025-12-13, **zero** issues/PRs — nothing there)
- git history of both `create_flatfile` implementations and `ena-submission/config/defaults.yaml`
  (local clone `/workspaces/claude-devcontainer/scratch/2026-09-15-loculus-embl-fix`)

---

## TL;DR — the one thing that matters

**ENA strips most source-feature qualifiers out of the flatfile we submit and re-injects its own
from the BioSample.** This is not inference; ENA told the team so in writing, and anna-parker
recorded it in [loculus#4817](https://github.com/loculus-project/loculus/issues/4817) (last comment):

> Just to update this thread if anyone finds it ENA wrote us that the country, collection_date and
> the following fields:
> ```
> /ecotype  /cultivar  /isolate  /strain  /sub_species  /variety  /sub_strain
> /cell_line  /serotype  /serovar  /environmental_sample  /organelle
> ```
> will be injected into the final ENA embl flat file from the biosample and are it seems (from our
> exchange) removed from the embl flat file we submit

The same conclusion, independently, in [loculus#3066](https://github.com/loculus-project/loculus/issues/3066)
(anna-parker):

> it should be noted that upon submission ENA drops these fields from the flatfile and they must be
> added to a biosample (where checklists are used) to be available in NCBI virus

So for the **ENA-submitted** flatfile (`ena_submission_helper.py`), adding source qualifiers that
overlap the sample record is largely a no-op at best. For the **user-downloadable** annotation file
(`preprocessing/.../embl.py`) none of this applies — nobody strips anything — so that side is where
extra qualifiers actually buy something.

---

## Findings, by issue/PR

### A. The "ENA overwrites/drops our source qualifiers" thread

| Ref | Title | What was attempted / found | ENA behaviour | Status |
|---|---|---|---|---|
| [loculus#4817](https://github.com/loculus-project/loculus/issues/4817) | Invalid(?) country name in EMBL files | Cornelius spotted ENA's published record shows `/geo_loc_name="Pakistan: Punjab"` where Loculus emits `/country="Pakistan: Punjab"`. Investigated whether `/country` is even legal for a non-country value. | **Accepted.** `/country` has been used since PR#2947 (Oct 2024) with no rejection, and the `country:region` form is valid per ENA WebFeat. Records surface on GenBank as `/geo_loc_name`. But it was *never established* whether that value comes from our flatfile or from the BioSample. | **Closed** (same day, 2025-08-06). Ends with the ENA "injected from biosample / removed from your flatfile" quote above. |
| [loculus#3066](https://github.com/loculus-project/loculus/issues/3066) | Check why we're not picking up `isolation_source=urine` in ingest | About ingest, but the discussion turned into the canonical statement of the flatfile-vs-sample split, plus an unresolved design argument: anna-parker wants to align Loculus metadata to the **ENA sample checklist ERC000033**, Cornelius wants to align to the **INSDC source-feature table** (`ebi.ac.uk/ena/WebFeat/source.html`). | n/a | **Open**, unresolved. This is the strategic fork that any flatfile-qualifier work lands in. |
| [loculus#2983](https://github.com/loculus-project/loculus/issues/2983) | Improve assembly field mapping | Item 2 asks literally: "Why does **isolate** get passed from biosample metadata but not other fields?" Answer recorded inline: "**ENA is working on this**". | `/isolate` reaches the published flatfile **from the BioSample**, not from ours. | **Open** since 2024-10. |
| [pathoplexus/ena-submission#76](https://github.com/pathoplexus/ena-submission/issues/76) | Coverage/Program/Platform not output into flatfiles despite being mandatory | Cornelius raised with ENA (broker ticket #792221) that mandatory manifest fields never appear anywhere public. ENA reply quoted in the issue: *"You are correct that we currently do not expose this information... stored in the analysis object/XML... only accessible from a submitter's private environment... I agree we should be displaying these... it is on our roadmap."* | **Silently dropped** from the public view. The data does reach NCBI and shows on the GCA page. | **Open.** Good evidence that "ENA accepted it" ≠ "it is visible". |
| [pathoplexus/ena-submission#65](https://github.com/pathoplexus/ena-submission/issues/65) | Update to geolocation on 12 Sierra Leone mpox assemblies | Revision of `/geo_loc_name` + `/collection_date` on 12 assemblies. After a full revision cycle, **1 of 12** actually got the qualifiers into the ENA flatfile; the other 11 lost the wrong value but never gained the right one; none propagated to NCBI. Escalated by email (broker #819420). | **Partially applied, mostly silently dropped.** Took weeks–months. | **Closed**, but the lesson stands: source qualifiers on already-submitted assemblies are near-impossible to revise. |
| [pathoplexus/ena-submission#193](https://github.com/pathoplexus/ena-submission/issues/193) | Trailing apostrophe in surname turned into `&apos` in flatfile (but not biosample) | ENA's own pipeline HTML-escaped an apostrophe in the flatfile. | ENA bug, ENA fixed it on request. | **Closed.** Cautionary: ENA post-processes the flatfile text. |

### B. `/db_xref` — the one candidate with a live, blocked ticket

| Ref | Title | Detail |
|---|---|---|
| [pathoplexus/ena-submission#85](https://github.com/pathoplexus/ena-submission/issues/85) | **Get db_xref into source qualifier of nucleotide file** | Opened 2025-07-14 by Cornelius: "Would be great if we could get /db_xref into source qualifiers of nucleotide sequences". One comment: "We should follow up on our application by email to Colman@ENA". **Still open, nothing implemented.** |
| [pathoplexus/ena-submission#86](https://github.com/pathoplexus/ena-submission/issues/86) | Submit sequences with (structured) GISAID crossref accessions | Establishes the blocker: `/db_xref` takes values only from the [INSDC registered db list](https://www.ncbi.nlm.nih.gov/genbank/collab/db_xref/). PPX applied to be registered as a db_xref database on **2024-10-09** via an EBI Google form and, as of the thread, **never received a reply**. Workarounds surveyed: `/note` source qualifier, or BioSample attributes. anna-parker notes flatfile changes are *in theory* automatable while manifest fields (e.g. `description`) require an email to ENA — "in practice this also hasn't worked too well". |
| [pathoplexus/ena-submission#92](https://github.com/pathoplexus/ena-submission/issues/92) | Add gisaid accession to the assembly | "We are not able to update the assembly description field automatically as it is in the manifest... We need to test if we can automatically update the `/note` qualifier" — i.e. **`/note` was proposed but never tested**. |

Note: `db_xref` **is** already emitted by the preprocessing flatfile, but on *gene/CDS* features
(e.g. `GeneID:37607636` from Nextclade), not on `source`. A `source`-level
`/db_xref="taxon:NNNN"` has never been tried in either implementation.

### C. `/segment` — handled by the chromosome list, not the flatfile

| Ref | Detail |
|---|---|
| [loculus#3682](https://github.com/loculus-project/loculus/issues/3682) | "Don't submit to ENA with a `segment: main` title". Quotes the ENA assembly docs: the `CHROMOSOME_NAME` column of `chromosome_list.tsv` "**will appear as the `/chromosome`, `/plasmid` or `/segment` qualifier in the EMBL-Bank flat files**". So ENA *generates* `/segment`; we never write it. Constraints: `^[A-Za-z0-9][A-Za-z0-9_#-.]*$`, <33 chars, unique, and must not contain `chr`/`chromosome`/`plasmid`/etc. Resolved by renaming `main` → `genome`. **Closed.** |
| [loculus#2983](https://github.com/loculus-project/loculus/issues/2983) | anna-parker tried leaving the segment name **empty**: webin-cli failed with `ERROR: Invalid [Ljava.lang.String;@7749bf93 format, failed to read entries.` — an uninformative Java-array-toString validation error. Suspected real cause: using `chromosome_type: segmented` for monopartite viruses. |

**Conclusion for `/segment`:** writing it into the source feature of the *submitted* flatfile risks
colliding with ENA's own generated qualifier. For the *downloadable* file it's free.

### D. `/country` vs `/geo_loc_name`

Yes, this has come up — three times, and there is a **concrete, current, unactioned recommendation**:

- [loculus#4817](https://github.com/loculus-project/loculus/issues/4817) (above) — `/country` works, ENA's WebFeat still documents `country`, published records show `geo_loc_name`.
- [loculus#3435](https://github.com/loculus-project/loculus/issues/3435) — quotes the INSDC `/geo_loc_name` definition and value format `"<geo_loc_name>[:<region>][, <locality>]"`; led to PR#3183 sending richer location strings. **Closed**; follow-up [#3437](https://github.com/loculus-project/loculus/issues/3437) (revise WNV geoloc) still **open**.
- **[loculus#7332](https://github.com/loculus-project/loculus/pull/7332) inline review comment** (claude[bot], on `ena_submission_helper.py:514`): *"INSDC renamed `/country` to `/geo_loc_name` in the Dec 2023 feature table release (v11.2). `/country` is still accepted as a deprecated synonym, so nothing is broken today, but if you're cleaning up qualifiers against the INSDC standard this is the obvious companion fix — here and in `preprocessing/.../embl.py:285`. Worth confirming ENA's validator accepts `geo_loc_name` before switching, and note it would touch the same three `.embl` fixtures."*

Nobody has yet tested whether ENA's validator accepts `/geo_loc_name`.

### E. `mol_type` / `molecule_type` (today's fix, for the record)

[loculus#7332](https://github.com/loculus-project/loculus/pull/7332) — `molecule_type` is not in the INSDC
feature table; `mol_type` is. **ENA silently corrected it**: published records show `/mol_type`
(e.g. `ebi.ac.uk/ena/browser/api/embl/PZ884253.1`). So this is a documented case of ENA *repairing*
a bad qualifier rather than rejecting the submission — a reason not to treat "our submissions
succeed" as evidence that the flatfile is correct. Both `create_flatfile` copies had to be edited.

### F. Flatfile creation bugs (context, not qualifier prior art)

- [loculus#5673](https://github.com/loculus-project/loculus/issues/5673) "EV: invalid embl flatfiles" — **open**. Flatfile is built from `enaDeposition` config values, so an organism whose config lacks them produces a flatfile with **another organism's name**. [PR#5685](https://github.com/loculus-project/loculus/pull/5685) (open) just sets `create_embl_file: false` for enterovirus to stop the bad files.
- [loculus#5007](https://github.com/loculus-project/loculus/issues/5007) EMBL flat file creation errors in S3 — **open**, logs lost.
- [loculus#4598](https://github.com/loculus-project/loculus/issues/4598) Nextclade attributes URL-encoded (`%3B`) — **closed**, fixed upstream in Nextclade. This was what blocked the convergence PR.
- [loculus#7331](https://github.com/loculus-project/loculus/pull/7331) (open, today) — codon_start vs phase, reverse-strand translation, trailing `*`, plus "some valid qualifiers were missing and 1 invalid qualifier was added" in the **gene/CDS** qualifier allow-lists (`EMBL_ANNOTATIONS` in `embl.py`). Source-feature qualifiers untouched.

### G. The sample-record side (where these fields already go)

- [loculus#2313](https://github.com/loculus-project/loculus/issues/2313) (closed) — the original ERC000033 mapping design. Notably it proposed `isolate ← specimen_collector_sample_id`, `collector name ← author`, `collecting institution ← sequenced_by_organization + author_affiliations`, `lab_host ← is_lab_host`.
- [loculus#6138](https://github.com/loculus-project/loculus/issues/6138) "Get as much info from Loculus into ENA as possible" (**open**) — the big audit. Key: `ena_checklist: ERC000033` is **commented out** in `defaults.yaml:30` ("do not use until all fields are mapped to ENA accepted options"), so submissions validate only against ENA's generic default. Several mapped fields send free text where ENA wants a closed vocabulary (`host_health_state`, `host_sex`, `hospitalisation` emits `true`/`false` instead of `yes`/`no`, `sample_capture_status`, `host_disease_outcome`). Two **mandatory** fields (`collector name`, `host subject id`) are hardcoded to `"not provided"` with empty `loculus_fields` — confirmed in the current `defaults.yaml`.
- [loculus#2984](https://github.com/loculus-project/loculus/issues/2984) Improve biosample field mapping (**open**) — note: ENA **accepted** BioSample attributes that are not in the checklist.
- [loculus#3408](https://github.com/loculus-project/loculus/issues/3408) Investigate mapping to NCBI fields (**open**) — explicitly flags `collected_by` vs `collecting_institution` as an unresolved distinction.
- [loculus#2772](https://github.com/loculus-project/loculus/pull/2772) (merged) — added lat/long as Loculus fields in decimal degrees "as expected by ENA", documented as WGS84. They go to the sample as `geographic location (latitude)` / `(longitude)` with `units: DD`. **Never** to the flatfile.
- [loculus#4730](https://github.com/loculus-project/loculus/pull/4730) (merged) / [#4713](https://github.com/loculus-project/loculus/pull/4713) (closed, superseded) — GISAID accession added as a BioSample attribute. Manual test confirmed ENA accepts a BioSample field that is *not* in ERC000033 (dry run on dev).

### H. Convergence of the two `create_flatfile` implementations

Yes — this was the explicit plan, and it is **stalled**:

1. [loculus#3739](https://github.com/loculus-project/loculus/issues/3739) (open) — "Annotate sequences for upload to ENA **and for download by user**": one annotation artefact serving both.
2. [loculus#4076](https://github.com/loculus-project/loculus/pull/4076) (closed) — Anna's first automation; includes `ena-submission/scripts/compare_embl.bash` to diff our flatfile against ENA's published one for a given accession. **Useful tool for validating any qualifier change.**
3. [loculus#4344](https://github.com/loculus-project/loculus/pull/4344) (closed) — did the full switch: prepro generates the file, deposition just downloads it. Explicitly "the 'create flatfile' part was moved out". Split into #4490 + #4503.
4. [loculus#4490](https://github.com/loculus-project/loculus/pull/4490) (**merged**, 2025-08-06) — prepro generates + uploads the annotation file. This is the `embl.py` implementation.
5. [loculus#4503](https://github.com/loculus-project/loculus/pull/4503) (**still open**) — "Use pre-computed EMBL file": submit the prepro-built file to ENA instead of rebuilding it in deposition. Was marked "seems good to go", then **BLOCKED** on #4598. #4598 is now fixed upstream, so this PR is unblocked but has not moved.
6. [loculus#7332](https://github.com/loculus-project/loculus/pull/7332) review comment (claude[bot], not blocking): *"the bug had to be fixed in two places because `create_flatfile` is duplicated between `ena-submission` and `preprocessing/nextclade` with near-identical source-feature construction. The two copies have already drifted slightly — preprocessing uses `seqIO_moleculetype.get(molecule_type, "DNA")` while ena-submission uses a direct `[...]` index that would raise `KeyError`. Worth a follow-up issue to share this, otherwise the next qualifier fix has the same double-edit footgun."*

Related but different: [loculus#7257](https://github.com/loculus-project/loculus/issues/7257) (open) asks for a **GenBank**-format flatfile download; anna-parker: "We have the option for flat files and this will be enabled on PPX soon — only the Genbank files aren't yet possible."

---

## Git-history check: was any qualifier ever added and then removed?

**No.** Pickaxe over both flatfile files for `isolate`, `db_xref`, `lat_lon`, `collected_by`,
`isolation_source`, `"host"`, `geo_loc_name`, `transl_table`:

- `isolate`, `lat_lon`, `collected_by`, `isolation_source`, `"host"`, `geo_loc_name`, `transl_table` — **zero commits ever**. They have never existed in either file.
- `db_xref` — only in the prepro gene/CDS qualifier allow-list (PR#4490 and later fixes), never on `source`.
- `segment` — only chromosome-list / multi-segment plumbing.

The source-feature qualifier set has been exactly `{molecule_type, organism, country, collection_date}`
since [PR#2947](https://github.com/loculus-project/loculus/pull/2947) (2024-10-04, the switch from FASTA to flatfile),
in both copies, unchanged for ~2 years. The only edit to the `source` block in that whole period is
today's `molecule_type` → `mol_type` rename.

The one adjacent commit that looks like a qualifier change is
[PR#4422](https://github.com/loculus-project/loculus/pull/4422) `ec9b171b7` "add more geolocation fields to assembly
embl flat file" — it does **not** add a qualifier, it enriches the *value* of `/country` by appending
`geoLocCity` and `geoLocSite` to the existing admin levels. It was not reverted.

**There is no revert. No qualifier has ever been refused by ENA in this codebase's history, because
none beyond the four has ever been tried.**

---

## Synthesis — answers to the five questions

### 1. Which of the seven candidates have known problems

| Candidate | Prior art | Verdict |
|---|---|---|
| `/isolate` | **Strong.** On ENA's explicit "injected from biosample, removed from your flatfile" list (#4817). Already flows to the sample as `isolate ← specimenCollectorSampleId` (`defaults.yaml`). #2983 confirms it reaches the published record from the BioSample. | **Duplicative and probably discarded** in the submitted file. Safe and genuinely useful in the downloadable file. |
| `/host` | No direct flatfile prior art. `host scientific name` and `host common name` already go to the sample. Not on ENA's injection list — so it might survive, but untested. | **Untested.** No known problem; also no evidence it survives. |
| `/isolation_source` | `isolation source host-associated` / `non-host-associated` already go to the sample. Mapping to Loculus fields is explicitly unresolved (#3066: overlaps `anatomicalMaterial` / `bodyProduct` / `environmentalMaterial` / `foodProduct`). Not on ENA's injection list. | **Untested at ENA; the source-value mapping is the real open question.** |
| `/lat_lon` | Zero flatfile prior art. Loculus stores decimal degrees (#2772); INSDC `/lat_lon` wants `"38.98 N 77.11 W"` — **a format conversion is required**, nobody has written it. Already goes to the sample as lat/long with `units: DD`. | **No prior art; needs a formatter.** |
| `/collected_by` | Zero flatfile prior art. Worse: the ENA sample field `collector name` is mapped to `loculus_fields: []` with `default: "not provided"` — **Loculus has no real collector data to put there** (#6138, confirmed in current `defaults.yaml`). #3408 flags `collected_by` vs `collecting_institution` as unresolved. | **Blocked on data, not on ENA.** `collecting institution` does have data (`sequencedByOrganization` + `authorAffiliations`). |
| `/db_xref="taxon:NNNN"` | **Open ticket** (ppx/ena-submission#85), unimplemented, with an adjacent registration request to EBI unanswered since 2024-10 (#86). `db_xref` is a controlled-vocabulary qualifier. `taxon:` is itself a legal INSDC db, so a taxon xref is separable from the PPX-registration problem — but note the sample already carries the taxon, and ENA derives the organism from it. | **Wanted, never attempted.** For taxon specifically the registration blocker does not apply; the duplication-with-sample argument does. |
| `/segment` | **Known conflict.** ENA generates `/segment` from `chromosome_list.tsv`'s `CHROMOSOME_NAME` (#3682). Leaving it empty produces an opaque webin-cli validation error (#2983). | **Do not add to the submitted flatfile** — ENA already writes it. Fine for the downloadable file. |

### 2. Is there an established reason the flatfile is deliberately minimal?

**Yes, and it is documented in the issue tracker but nowhere in the code or docs.** ENA takes source
metadata from the **SAMPLE (BioSample) record**, strips the overlapping qualifiers out of the
submitted flatfile, and re-injects its own. Stated by ENA and recorded in loculus#4817; restated
independently in loculus#3066; corroborated by loculus#2983 (`/isolate` arrives from the BioSample)
and by ppx/ena-submission#76 (manifest fields never surface at all).

Two important caveats:
- It was **never minimal by deliberate design** — it started as the minimum needed to carry AUTHORS
  (PR#2947 switched FASTA → flatfile purely to get author attribution through), and simply never
  grew. There is no commit, comment or doc saying "we tried more and backed off".
- ENA's list of injected-from-biosample qualifiers (`ecotype cultivar isolate strain sub_species
  variety sub_strain cell_line serotype serovar environmental_sample organelle`, plus country and
  collection_date) **does not include** `host`, `isolation_source`, `lat_lon`, `collected_by`,
  `db_xref` or `segment`. Whether those survive is genuinely unknown.

None of this constrains `preprocessing/.../embl.py`, whose output is a user download and never
reaches ENA today.

### 3. `/country` vs `/geo_loc_name`

**Yes, it has come up** — see §D. Current state: `/country` is the deprecated synonym (INSDC feature
table v11.2, Dec 2023), it is accepted by ENA today, published records render as `/geo_loc_name`,
and there is an explicit unactioned recommendation on PR#7332 to rename in both files together with
the three `.embl` fixtures — with the caveat "**worth confirming ENA's validator accepts
`geo_loc_name` before switching**". No one has confirmed that.

### 4. `transl_table` / genetic codes

**No prior art found.** Zero hits for `transl_table`, `transl_except`, `genetic_code` or
`geneticCode` anywhere in the loculus repo, and zero issues/PRs across all four repos. The only
adjacent item is [loculus#2841](https://github.com/loculus-project/loculus/issues/2841) ("We currently
include stop codons in protein sequences"), which is about SILO/website translations, not the
flatfile — though PR#7331 does strip the trailing `*` from `/translation` per INSDC convention.
Every CDS in both implementations is translated with Biopython's default table 1, implicitly.

### 5. Were the two `create_flatfile` implementations meant to converge?

**Yes, explicitly.** See §H. The plan was #3739 → #4076 → #4344 → (#4490 merged, **#4503 still open**).
#4503 would make deposition *download* the prepro-built file instead of rebuilding it, which would
delete the ena-submission copy entirely. It was blocked on #4598 (Nextclade URL-encoding), which is
now **fixed upstream** — so #4503 is unblocked and merely stale. The duplication and its drift were
flagged again today on PR#7332 with a suggestion to open a follow-up issue.

**Practical consequence for the current plan:** any qualifier added to only one copy widens a gap
that an open PR is supposed to close. If the two are going to merge, the merged source feature has
to be legal for *both* consumers — which argues for adding qualifiers that are harmless-if-stripped
(`/host`, `/isolation_source`, `/lat_lon`, `/db_xref="taxon:"`) and avoiding the one ENA generates
itself (`/segment`).

---

## Suggested checks before implementing (all unattempted so far)

1. `ena-submission/scripts/compare_embl.bash ACCESSION ORGANISM` (from PR#4076) diffs our flatfile
   against ENA's published one — the existing tool for answering "did ENA keep it?" empirically.
2. `ena-webin-cli -context genome -validate` against the ENA **dev** endpoint is the cheap
   accept/reject test; #4713 shows the team already uses dry runs on dev for exactly this.
3. `/lat_lon` needs a DD → `"38.98 N 77.11 W"` formatter; none exists.
4. `/collected_by` has no source data — `collector name` is hardcoded `"not provided"`.
