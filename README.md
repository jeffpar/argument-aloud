# Argument Aloud

## For The Sake of Argument

Every U.S. Supreme Court case ends in a decision, but it starts with arguments, and those arguments come in many forms: the initial petition, a series of briefs, and then usually oral arguments, all of which have been recorded since October 1955 and transcribed since October 1968.

Unfortunately, all those pieces tend to be scattered.  Even the Supreme Court's own [website](https://www.supremecourt.gov) directs you to different pages for *every* one of those pieces.  Other essential pieces of information, such as copies of statutes, records from the lower courts, etc, can usually be found in the briefs or elsewhere, but you have to know where to look.

So we've created this "hub" to help connect those pieces.  Here's an example: an excerpt from the March 23, 2026 argument in [Watson v. RNC (No. 24-1260)](/courts/ussc/?term=2025-10&case=24-1260&turn=369), with links to documents that activate automatically as the argument progresses.

This website barely scratches the surface of what is possible, but hopefully it will give you sense of what a modern UI can accomplish, and maybe it will even inspire others to "follow suit."

## For The Sake of Accuracy

We rely only on "authoritative" sources, starting with [The U.S. Supreme Court](https://www.supremecourt.gov), as well as the [The National Archives](https://www.archives.gov), [The Oyez Project](https://www.oyez.org), and [The Supreme Court Database](https://scdb.la.psu.edu); however, authoritative does not mean error-free.  For example:

  - The transcript for [Rogers v. Tennessee (No. 99-6218)](https://www.supremecourt.gov/pdfs/transcripts/2000/99-6218.pdf) is incorrectly dated [11/08/00](https://www.supremecourt.gov/oral_arguments/argument_transcript/2000); the correct date is November 1, 2000.

  - The transcript for [Batson v. Kentucky (No. 84-6263)](https://www.supremecourt.gov/pdfs/transcripts/1985/84-6263_12-02-1985.pdf) is incorrectly dated [12/2/1985](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1985); the correct date is December 12, 1985.

Data from [The Oyez Project](https://www.oyez.org) is slightly more problematic, as we've [noted](https://argumentaloud.org/courts/ussc/?link=/nara/audit), but being able to compare multiple data sources, including [The Supreme Court Database](https://argumentaloud.org/courts/ussc/?link=/nara/audit#the-supreme-court-database-revisited), has been a great way of flushing out mistakes, on all sides.

And make no mistake: these are all simple, minor mistakes, so we don't mean to blow them out of proportion, but they do create problems when trying to connect all the pieces for all the cases.  We make corrections here as we find them, but without the ability to feed those corrections back to their source, disconnects will persist.

## For The Sake of Completeness

Missing data is also a problem; for example:

  - The transcript for [Reno v. Bossier Parish School Bd. (No. 98-405)](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1998) cannot be downloaded; the URL is listed as `https://www.supremecourt.gov/pdfs/transcripts/1998/98-405_98-406_04-26-1999.pdf`

It also appears that Justia assumes one-case-per-page in their U.S. Supreme Court [Opinions by Volume](https://supreme.justia.com/cases/federal/us/volume/) collection, at least in older volumes, which isn't always true.  For example, [Volume 6](https://supreme.justia.com/cases/federal/us/6/) lists only one case, "Williams & Hodgson v. Lyles", at "6 U.S. 9", but an earlier case, "Wood v. Wagnon", also appears on that page.

Advocate data is another challenge, because it's not recorded anywhere as a separate set of data.  The Court does record advocate names in various places, including [Transcripts](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1969), [Journals](https://www.supremecourt.gov/orders/journal.aspx), and [U.S. Reports](https://www.supremecourt.gov/opinions/USReports.aspx), but they presumably track that information separately as well, because on rare occasions, the Chief Justice will congratulate an attorney (e.g., [Edwin Kneedler](https://argumentaloud.org/courts/ussc/?collection=top100_advocates&id=edwin_s_kneedler)) for having just argued their 100th case.

Extracting advocate data from printed/scanned journals and transcripts is non-trivial and error-prone, and disambiguating names (ie, understanding when two similar names are different people, or vice versa) requires time.  For cases from the October Term 1955 onward, we rely largely on transcripts, and for certain groups of advocates, we have either done our own research, as we did for [Justice Advocates](https://argumentaloud.org/courts/ussc/?collection=justice_advocates), or we have supplemented the research of others; see [Women Advocates](https://argumentaloud.org/courts/ussc/?collection=women_advocates).

There is still more work to do in terms of producing a complete and accurate list of [Top Advocates](https://argumentaloud.org/courts/ussc/?collection=top100_advocates).  Of course, if the Court shared its advocate data with the public, that would be even better.

## TODO

  - The [Library of Congress](https://www.loc.gov) currently has copies of opinions from U.S. Reports as far forward as [Volume 578](https://www.loc.gov/search/?fa=partof:u.s.+reports:+volume+578). Unfortunately, they suffer from some sloppiness; for example, there is no entry for **Sullivan v. Florida (560 U.S. 181)**; you can only find it at the bottom of the document for [United States v. Comstock (560 U.S. 126)](https://tile.loc.gov/storage-services/service/ll/usrep/usrep560/usrep560126/usrep560126.pdf#page=56). There are numerous other instances where opinions that should exist on loc.gov cannot be found, so at some point, a comprehensive audit should be performed.

  - Happily, the U.S. Supreme Court continues to "up its game" and now provides online copies of all [U.S. Reports Volumes](https://www.supremecourt.gov/opinions/USReports.aspx), so that may prove to be a better, more reliable source going forward.  We will need to add a process for converting all `opinion_href` links to the correct page within those PDFs.  Unfortunately, some of the (earlier) volumes have unusual page numbering (eg, in [Volume 6](https://www.supremecourt.gov/pdfs/USReports/USREPORTS-6_PDFA.pdf), page numbers such as 12 and 15 are skipped).

## Command-Line Examples

Adding missing cases:

`node scripts/update_cases.js 1952-10 --add "United States v. Wilson|United States v. Purchasing Corporation of America" --number 197,198 --argument 1953-01-05,1953-01-06 --decision 1953-02-02 --cite 344 U.S. 923 --votes 6-2 loss --dissent douglas burton --recused clark --appellant John F. Davis --appellee Selden S. McNeer`

`node scripts/update_cases.js 1952-10 --add "Ward v. United States" --number 390 --argument 1953-01-13 --decision 1953-02-02 --cite 344 U.S. 924 --votes 9-0 win --petitioner John M. Coe --petitioner Ralph E. Powe --respondent John R. Benney`

Adding votes to an existing case:

`node scripts/update_cases.js 2025-10 25-112 --votes win 6-3 kagan --dissent alito barrett --minority thomas`

Applying a downloaded set of transcript edits (speaker/text corrections submitted via "Download Edits" in the transcript editor) — this patches the named turns directly in their transcript JSON files and records a changelog entry at `courts/ussc/transcripts/updates`:

`node scripts/update_transcripts.js ussc-edits.json`

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

![U.S. Supreme Court Courtroom](/assets/img/ussc_courtroom1.jpg)  
[[Source](https://www.supremecourt.gov/about/photos.aspx)]

![Photograph of Supreme Court Building](/assets/img/scotus.gif)  
[[Source](https://catalog.archives.gov/id/594954)]
