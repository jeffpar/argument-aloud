# [Argument Aloud](https://argumentaloud.org)

## For The Sake of Argument

Every U.S. Supreme Court case ends in a decision, but it starts with arguments, and those arguments come in many forms: the initial petition, a series of briefs, and then usually oral arguments, all of which have been recorded since October 1955 and transcribed since October 1968.

Unfortunately, all those pieces tend to be scattered.  Even the Supreme Court's own [website](https://www.supremecourt.gov) directs you to different pages for *every* one of those pieces.  Other essential pieces of information, such as copies of statutes, records from the lower courts, etc, can usually be found in the briefs or elsewhere, but you have to know where to look.

So we've created [Argument Aloud](https://argumentaloud.org), a "hub" built from data files in this repository that helps connect those pieces.  Here's an example: an excerpt from the March 23, 2026 argument in [Watson v. RNC (No. 24-1260)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1260&turn=369), with links to documents that activate automatically as the argument progresses.

[Argument Aloud](https://argumentaloud.org) barely scratches the surface of what is possible, but hopefully it will give you sense of what a modern UI can accomplish, and maybe it will even inspire others to "follow suit."

## For The Sake of Accuracy

We rely only on "authoritative" sources, starting with [The U.S. Supreme Court](https://www.supremecourt.gov), as well as the [The National Archives](https://www.archives.gov), [The Oyez Project](https://www.oyez.org), and [The Supreme Court Database](https://scdb.la.psu.edu); however, authoritative does not mean error-free.  For example:

  - The transcript for [Rogers v. Tennessee (No. 99-6218)](https://www.supremecourt.gov/pdfs/transcripts/2000/99-6218.pdf) is incorrectly dated [11/08/00](https://www.supremecourt.gov/oral_arguments/argument_transcript/2000); the correct date is November 1, 2000.

  - The transcript for [Batson v. Kentucky (No. 84-6263)](https://www.supremecourt.gov/pdfs/transcripts/1985/84-6263_12-02-1985.pdf) is incorrectly dated [12/2/1985](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1985); the correct date is December 12, 1985.

Data from [The Oyez Project](https://www.oyez.org) is slightly more problematic, as we've [noted](https://argumentaloud.org/courts/ussc/?link=/sources/nara/audit), but being able to compare multiple data sources, including [The Supreme Court Database](https://argumentaloud.org/courts/ussc/?link=/sources/nara/audit#the-supreme-court-database-revisited), has been a great way of flushing out mistakes, on all sides.

And make no mistake: these are all simple, minor mistakes, so we don't mean to blow them out of proportion, but they do create problems when trying to connect all the pieces for all the cases.  We make corrections here as we find them, but without the ability to feed those corrections back to their source, disconnects will persist.

## For The Sake of Completeness

Missing data is also a problem; for example:

  - The transcript for [Reno v. Bossier Parish School Bd. (No. 98-405)](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1998) cannot be downloaded; the URL is listed as `https://www.supremecourt.gov/pdfs/transcripts/1998/98-405_98-406_04-26-1999.pdf`

It also appears that Justia assumes one-case-per-page in their U.S. Supreme Court [Opinions by Volume](https://supreme.justia.com/cases/federal/us/volume/) collection, at least in older volumes, which isn't always true.  For example, [Volume 6](https://supreme.justia.com/cases/federal/us/6/) lists only one case, "Williams & Hodgson v. Lyles", at "6 U.S. 9", but an earlier case, "Wood v. Wagnon", also appears on that page.

Advocate data is another challenge, because it's not recorded anywhere as a separate set of data.  The Court does record advocate names in various places, including [Transcripts](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1969), [Journals](https://www.supremecourt.gov/orders/journal.aspx), and [U.S. Reports](https://www.supremecourt.gov/opinions/USReports.aspx), but they presumably track that information separately as well, because on rare occasions, the Chief Justice will congratulate an attorney (e.g., [Edwin Kneedler](https://argumentaloud.org/courts/ussc/?collection=top100_advocates&id=edwin_s_kneedler)) for having just argued their 100th case.

Extracting advocate data from printed/scanned journals and transcripts is non-trivial and error-prone, and disambiguating names (ie, understanding when two similar names are different people, or vice versa) requires time.  For cases from the October Term 1955 onward, we rely largely on transcripts, and for certain groups of advocates, we have either done our own research, as we did for [Justice Advocates](https://argumentaloud.org/courts/ussc/?collection=justice_advocates), or we have supplemented the research of others; see [Women Advocates](https://argumentaloud.org/courts/ussc/?collection=women_advocates).

There is still more work to do in terms of producing a complete and accurate list of [Top Advocates](https://argumentaloud.org/courts/ussc/?collection=top100_advocates).  Of course, if the Court shared its advocate data with the public, that would be even better.

#### Regarding Dates of Decisions

As we mention [here](https://argumentaloud.org/courts/ussc/?source=ussc&id=reports), the Court published what we generally consider the "definitive" list of all (early) "Dates of Supreme Court Decisions and Arguments" for decisions in 1791 through 1882.  Unfortunately, it is definitive only for cases reported in Volumes 2 through 107 of U.S. Reports, missing cases that were reported in later volumes.

For example, in U.S. Reports [Volume 154](https://www.supremecourt.gov/pdfs/USReports/USREPORTS-154_PDFA.pdf#page=553), there is a section titled "SOME CASES NOT HITHERTO REPORTED IN FULL" which includes this preamble:

> The Centennial Appendix, at the end of Volume 131, contained two tables of omitted cases. In the first table the cases were reported in full. The second contained only a list of cases, term by term [see pages ccxx to ccxxxi], in which opinions were given which were supposed to decide the case on the facts; or on the authority of some case referred to; or in which the decision was made partly on the facts and partly on such authority; or in which judgment was entered either on the stipulation of the parties, or for incompleteness of the record, or for non-compliance with the rules of court. It was assumed that it was not worth while to occupy the space necessary to report these cases in full. The fact that two or three of them have been referred to in opinions of the court, since rendered, shows that this assumption was not well founded, and calls upon the reporter now to print them in full.

So, for example, the case "1863-12/1863-084 (267): Milwaukee & Minnesota R. Co. v. Soutter", which was originally listed as No. 268 and argued on Monday, February 1, 1864, was reported in Volume 131 as No. 267, argued on February 1-9, 1864, and decided on Tuesday, February 23, 1864.  However, this later report fails to mention that 68 U.S. 405 lists the case as being decided with "Bronson v. La Cross & Milwaukee R. Co.", which *does* appear in the "Dates of Decisions."  We assume that both cases were not only decided together but also argued together, on February 1-5 and 8-9; those 7 dates also seem more plausible than 9 straight days.

Other examples of cases not mentioned in "Dates of Supreme Court Decisions and Arguments":

  - [United States v. Carrère (1853)](https://argumentaloud.org/courts/ussc/?term=1852-12&case=78)

While reviewing all argument dates, we have unfortunately noticed some mistakes in U.S. Reports.  For example, 355 U.S. 184 reports that [Green v. United States (No. 46)](https://argumentaloud.org/courts/ussc/?term=1957-10&case=46) was reargued on October 15, 1957; however, the 1957 Journal indicates that, while No. 46 was *scheduled* for that day, they apparently ran out of time, because argument did not commence until the following day, on October 16, 1957.

Similarly, 445 U.S. 480 reports that [Vitek v. Jones (No. 78-1155)](https://argumentaloud.org/courts/ussc/?term=1979-10&case=78-1155) was argued on December 3, 1979, but all other evidence (journal, audio recording, transcript) indicates it was actually argued on December 5, 1979.  And 449 U.S. 200 reports that [United States v. Will](https://argumentaloud.org/courts/ussc/?term=1980-10&case=79-983) was argued on October 13, 1980, but the correct date is October 14, 1980; the Court was not even in session on October 13.

## Curiosities

  - I'm curious about the backstory in a case from the 1943 term, Franks Bros. Co. v. NLRB (No. 521), because argument commenced on March 2, 1944 but wasn't completed until March 27, 1944.

## TODO

  - The [Library of Congress](https://www.loc.gov) currently has copies of opinions from U.S. Reports as far forward as [Volume 578](https://www.loc.gov/search/?fa=partof:u.s.+reports:+volume+578). Unfortunately, they suffer from some sloppiness; for example, there is no entry for **Sullivan v. Florida (560 U.S. 181)**; you can only find it at the bottom of the document for [United States v. Comstock (560 U.S. 126)](https://tile.loc.gov/storage-services/service/ll/usrep/usrep560/usrep560126/usrep560126.pdf#page=56). There are numerous other instances where opinions that should exist on loc.gov cannot be found, so at some point, a comprehensive audit should be performed.

  - Happily, the U.S. Supreme Court continues to "up its game" and now provides online copies of all [U.S. Reports Volumes](https://www.supremecourt.gov/opinions/USReports.aspx), so that may prove to be a better, more reliable source going forward.  We will need to add a process for converting all `opinion_href` links to the correct page within those PDFs.  Unfortunately, some of the (earlier) volumes have unusual page numbering (eg, in [Volume 6](https://www.supremecourt.gov/pdfs/USReports/USREPORTS-6_PDFA.pdf), page numbers such as 12 and 15 are skipped).

  - Complete the Original Jurisdiction Archive. The [Court](https://www.supremecourt.gov/casedocuments/original_jurisdiction_cases.aspx) lists 147 numbered original-jurisdiction cases (Nos. 1–147, Orig., spanning 1922–2016). The remaining cases are listed below.

| No. | Case | Year | Docs on SCOTUS page |
|---|---|---|---|
| 104 | New Jersey v. Nevada | 1985 | 5 |
| 107 | Michigan v. Meese | 1986 | 3 |
| 110 | Matter of Republic of Suriname ex Rel. Boerenveen | 1987 | 3 |
| 116 | Alabama v. W.R. Grace & Co. | 1990 | 12 |
| 119 | Connecticut v. New Hampshire | 1991 | 19 |
| 123 | Corrinet v. Boutros Ghali | 1995 | 2 |
| 124 | Collins v. Alabama | 1996 | 1 |
| 125 | Republic of Paraguay v. Gilmore | 1998 | 7 |
| 131 | SE Interstate Low-Level Radioactive Waste v. North Carolina | 2000 | 5 |
| 135 | Texas v. Leavitt | 2006 | 6 |
| 136 | Brzak v. United Nations | 2006 | 1 |
| 139 | Mississippi v. City of Memphis, Tenn., Memphis Light, Gas & Water Div. | 2009 | 5 |
| 140 | Louisiana v. Bryson | 2011 | 7 |
| 144 | Nebraska v. Colorado | 2014 | 7 |
| 146 | Arkansas v. Delaware | 2016 | 34 |

  The workflow to integrate new Original Jurisdiction Archive cases:

```
node scripts/import_ussc.js --orig
node scripts/download.js TERM CASE --thumbs
node scripts/update_cases.js --collections
```

  - There are some cases with no citation (and media files to display) and are thus currently "hidden" from view.  We need to track down citations for the following.

| Term | Number | Title | Decision |
|---|---|---|---|
| 1864-12 | 5-Orig | ex parte Milwaukie and Minnesota Railroad Company | 1865-02-20 |
| 1869-12 | 281 | Hartford Fire Insurance Company v. Issac Van Duzer | 1870-04-25 |
| 1872-12 | (none) | Barnes v. The Railroads | 1873-04-28 |
| 1878-10 | 239 | The First National Bank of The City of New York v. Abner C. Shoemaker | 1878-12-16 |
| 1879-10 | 174 | Edwin C. Litchfield v. County of Hamilton | 1880-03-08 |
| 1879-10 | (none) | Railroad Co. v. Alabama | 1880-05-10 |
| 1882-10 | 1151 | The Union Trust Company of New York v. Edward Fitzgerald | 1883-03-12 |
| 1883-10 | 138 | Cook v. Sandusky Tool Company | 1884-01-21 |

## Command-Line Examples

Adding missing cases:

`node scripts/update_cases.js 1952-10 --add "United States v. Wilson|United States v. Purchasing Corporation of America" --number 197,198 --argument 1953-01-05,1953-01-06 --decision 1953-02-02 --cite 344 U.S. 923 --votes 6-2 loss --dissent douglas burton --recused clark --appellant John F. Davis --appellee Selden S. McNeer`

`node scripts/update_cases.js 1952-10 --add "Ward v. United States" --number 390 --argument 1953-01-13 --decision 1953-02-02 --cite 344 U.S. 924 --votes 9-0 win --petitioner John M. Coe --petitioner Ralph E. Powe --respondent John R. Benney`

Adding votes to an existing case:

`node scripts/update_cases.js 2014-10 13-10400 --votes loss` (eg, a per curiam opinion)

`node scripts/update_cases.js 2025-10 25-112 --votes win 6-3 kagan --dissent alito barrett --minority thomas`

Adding advocates to an existing case:

`node scripts/update_cases.js 1938-10 771 --date 1939-04-24 --journal 1938.212 --advocate "ROBERT JACKSON|MR.,SOLICITOR GENERAL|appellant"`

`node scripts/update_cases.js 1938-10 771 --date 1939-04-25 --journal 1938.213 --advocate "ROBERT JACKSON|MR.,SOLICITOR GENERAL|appellant" --advocate "LEONARD ACKER|MR.|appellee" --advocate "WILLARD R. PRATT|MR.|appellee"`

Applying a downloaded set of transcript edits (speaker/text corrections submitted via "Download Edits" in the transcript editor) — this patches the named turns directly in their transcript JSON files and records a changelog entry at `courts/ussc/transcripts/updates`:

`node scripts/update_transcripts.js ussc-edits.json`

Parsing Journal data into XML files:

`node scripts/parse_journals.js 1889`

Checking Case dates against Journal dates:

`node scripts/parse_journals.js 1889 --verify-case-dates`

Checking Journal dates against Case dates:

`node scripts/parse_journals.js 1889 --verify-journal-dates`

Checking Journal dates against Case dates and offering to add Advocate data:

`node scripts/parse_journals.js 1889 --verify-journal-dates --prompt`

Building date information from Engrossed Minutes (eg, for Volumes 51 - 53; April 25, 1887 - May 13, 1889):

`node scripts/parse_minutes.js https://catalog.archives.gov/id/178846789`

Parsing Minutes user edits into Minutes date files:

`node scripts/parse_minutes.js ~/Downloads/ussc-dates.json`

## MIT License

Project design (c) 2026 by Jeff Parsons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

![U.S. Supreme Court Courtroom](/assets/img/ussc/courtroom1.jpg)  
[[Source](https://www.supremecourt.gov/about/photos.aspx)]

![Photograph of Supreme Court Building](/assets/img/nara/scotus.gif)  
[[Source](https://catalog.archives.gov/id/594954)]
