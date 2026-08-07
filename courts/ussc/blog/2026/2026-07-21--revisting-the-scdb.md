---
title: "Revisiting the SCDB"
layout: pane
date: 2026-07-21
permalink: /courts/ussc/blog/2026/revisiting-the-scdb/
---

# Revisiting the Supreme Court Database

*{{ page.date | date: "%A, %B %-d, %Y" }}*

This post discusses the [[U.S.] Supreme Court Database](/courts/ussc/?source=scdb), which was used to help build this hub. It is simultaneously both an invaluable resource and an occasional source of frustration, as we'll see below.

Currently, this site is using version "2025 Release 01" of the Modern Database and version "SCDB Legacy 07" of the Legacy Database. Per the database's [citation](https://scdb.la.psu.edu/how-to-cite-us/) guidelines:

> Harold J. Spaeth, Lee Epstein, Michael J. Nelson, Andrew D. Martin, Jeffrey A. Segal, Theodore J. Ruger, and Sara C. Benesh. 2024. Supreme Court Database, Versions 2025 Release 01 and Legacy 07. https://scdb.psu.edu

It's also worth noting that, in 2024, the database's home [moved](https://www.psu.edu/news/liberal-arts/story/us-supreme-court-database-now-housed-penn-state-department-political-science) to [Penn State College of Liberal Arts](https://scdb.la.psu.edu). While the new site looks great, it does lack some of the features of the previous [Washington University Law](http://scdb.wustl.edu/index.php) site, like the [Analysis](http://scdb.wustl.edu/analysis.php) page, and in the two years since the move, nothing much has changed -- except of course the 2025 database release. It's also strange that the previous site continues to update its releases to match those at Penn State, while making no mention of the database's move, nor any indication of what might happen to the **supremecourtdatabase.org** domain.

## Dates of Argument, Reargument, and Decision

On this site, under Collections, you'll find a group named [Audits](/courts/ussc/?collection=audits&link=/courts/ussc/blog/2026/revisiting-the-scdb/), and in there, you'll find a number of other interesting groups, but the one we're going to focus on here is named [Cases with SCDB Errors](/courts/ussc/?collection=audits&id=scdb-errors&sort=decided&o=a&link=/courts/ussc/blog/2026/revisiting-the-scdb/).

This is an automatically-generated list of all cases where we have flagged an issue with one more of the dates that SCDB has recorded for those cases; specifically, their *dateArgument*, *dateRearg*, and *dateDecision* fields.

Since we rely on the U.S. Supreme Court's own meticulous research, "[DATES OF SUPREME COURT DECISIONS AND ARGUMENTS](/courts/ussc/?source=ussc&group=9)", for all cases decided from 1791 through 1882, any deviations from that research are suspect. And there are numerous SCDB deviations. For example, [Miller v. Kerr (1821)](/courts/ussc/?collection=audits&id=scdb-errors&term=1821-02&case=1822-019&sort=decided&o=a) is documented by the Court as being argued on March 13, 1821 and decided two days later on March 15, 1821.

SCDB claims that it, too, is relying on the Court's research; regarding *dateDecision*, it says:

> This variable contains the year, month, and day that the Court announced its decision in the case. For volumes 2-107 of the U.S. Reports (1791-1882), we relied on Dates of Supreme Court Decisions and Arguments, prepared by Anne Ashmore of the Library of the Supreme Court, because many early reporters do not list the date of decision.

And yet, SCDB set *dateDecision* in **Miller v. Kerr** to March 15, 1822 instead of 1821. Since this type of deviation occurs repeatedly, it seems less likely a simple "typo" and more likely that someone concluded they had a better source of information. But nowhere is there any notation, either in the case record or anywhere else on the website, of what this better source might have been.

Here's a clue though: if you examine [Miller v. Kerr (1821)](/courts/ussc/?collection=audits&id=scdb-errors&term=1821-02&case=1822-019&sort=decided&o=a), you'll see that the U.S. Reports heading is "FEBRUARY TERM, 1822", which might lead someone to believe this case must have been decided in 1822... until you read a bit further, where it says:

> This cause was argued and determined at the last term, but omitted to be reported.

And so it goes.

NOTE: Before we revisit my 2019 blog post on SCDB below, I want to make it clear that the data on *this* site is certainly not error-free either. My concern is less about errors and more about transparency and having a process for reporting errors, recording corrections, and citing the correct sources -- something that even this project does not do consistently.

But we're working on it. If you look at a case like [Green v. United States (1957)](/courts/ussc/?term=1957-10&case=46), you will now see the following message:

> U.S. Reports indicates argument on October 15, 1957, but the Journal indicates otherwise

For a list of *all* cases where we have noted one or more corrections, check out our newest collection, [Cases with Warnings](/courts/ussc/?collection=audits&id=warnings&sort=decided&o=a&link=/courts/ussc/blog/2026/revisiting-the-scdb/).

---

## SCDB: How Do I Love Thee?

*Originally posted on February 18, 2019 on [lonedissent.org](https://lonedissent.org/blog/2019/02/18/) and reproduced below with some minor changes and link updates*

The [Supreme Court Database](https://scdb.la.psu.edu), aka SCDB[*](#citing-to-the-scdb), is an enormously valuable resource. Other [sites](https://www.courtlistener.com/coverage/) have even referred to it as "the gold standard for high-quality legal information." It owes much of its reputation to Harold Spaeth, a political science professor who created "[The Original U.S. Supreme Court Judicial Database (nickname: ALLCOURT)](http://artsandsciences.sc.edu/poli/juri/sct.htm)" decades ago, and worked with the SCDB folks to help produce the modern version. Sadly, Harold passed away in 2017.

So, regarding the SCDB: does it really meet the "gold standard", and what does that mean in a field with only one real competitor? Is there room for improvement? Let's find out.

## Let Me Count The Ways

### 1. Docket Numbers

Here are some examples of SCDB docket numbers for [Original Jurisdiction](https://en.wikipedia.org/wiki/Original_jurisdiction_of_the_Supreme_Court_of_the_United_States) cases:

    "5, Orig."
    "126, ORIG."
    "10 Original"
    "8 (Original)"
    "15 orig."
    "6 ORIG"
    "8 original"
    "ORIG" and "   ORIG"
    "15 ORIG ORIG" (just to be sure?)
    "No. 12, Original"
    "No. 137, Orig."
    "22O142"

Yes, the human eye can easily discern that these are all original jurisdiction docket numbers, but databases are designed to be consumed by computers, not humans, and one of the presumptions for *any* database is well-defined and strictly-adhered-to data formats. Even after consulting SCDB's online codebook regarding the [docket](https://scdb.la.psu.edu/online-codebook/docket-number/) field, this is all we're told about such docket numbers:

> Cases invoking the Court's original jurisdiction have a number followed by the abbreviation, "Orig."

Well, apparently, there's more to it than that.

There's also a small problem with "Miscellaneous" cases; SCDB usually appends a single letter ("M") to the docket number, but sometimes there's a space (eg, "61 M") and sometimes not (eg, "133M").

### 2. Consolidated Cases

The U.S. Supreme Court often "consolidates" multiple cases from lower courts into a single case. For example, the docket number of the "lead" case in [McConnell v. Federal Election Commission (540 U.S. 93)](/courts/ussc/?term=2003-10&case=02-1674) is 02-1674. However, the complete list of consolidated cases, by docket number, looks like this:

    02-1674,02-1675,02-1676,02-1702,02-1727,02-1733,02-1734,02-1740,02-1747,02-1753,02-1755,02-1756

and if you download SCDB's "[Cases Organized by Docket](https://scdb.la.psu.edu/data/2018-release-02/)" and search for **540 U.S. 93**, you will indeed see all 12 cases listed.

So what's the problem?  Consolidated cases are not *consistently* included.

For example, look at [East Texas Motor Freight System, Inc. v. Rodriguez (431 U.S. 395)](/courts/ussc/?term=1976-10&case=75-718). Three cases were consolidated:

    75-718,75-651,75-715

but even when using SCDB's "Cases Organized by Docket" files, all you'll find is 75-718.

There may be some rationale at work here. For example, it's possible that the disposition of the "non-lead" cases did not differ in any material way from the "lead" case, so the other cases were deemed superfluous. But there are numerous examples where the exact opposite is true (i.e., all consolidated cases recorded even when they all had the same disposition), so that would be a rationale of convenience rather than of principle.

The SCDB website simply says:

> Multiple docket numbers under a single case citation almost always contain the same issue as the lead case and differ only in the parties to the case and its origin and source.

And this isn't a trivial problem. When you look for the transcript for [East Texas Motor Freight System](/courts/ussc/?term=1976-10&case=75-718) on the [Supreme Court's](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1976) website, it's *only* listed as [Teamsters v. Rodriguez, No. 75-651](https://www.supremecourt.gov/pdfs/transcripts/1976/75-651_75-715_75-718_01-10-1977.pdf). Not as 75-715 or 75-718, but as 75-651 -- a docket number which you will *not* find in the SCDB.

### 3. Decision Dates

For a case's [Date of Decision](https://scdb.la.psu.edu/online-codebook/date-of-decision/), the SCDB online codebook says:

> This variable contains the year, month, and day that the Court announced its decision in the case. For volumes 2-107 of the U.S. Reports (1791-1882), we relied on [Dates of Supreme Court Decisions and Arguments](http://www.supremecourt.gov/opinions/datesofdecisions.pdf), prepared by Anne Ashmore of the Library of the Supreme Court, because many early reporters do not list the date of decision.

Importing dates from a Supreme Court document should have been an error-free process, yet it wasn't. Take the case of [United States v. McDowell (8 U.S. 316)](/courts/ussc/?term=1808-02&case=1807-025). SCDB claims it was decided on March 7, 1807, but the Supreme Court's "Dates of Supreme Court Decisions and Arguments" document -- which SCDB says it relied upon -- indicates March 7, 1808. I have found dozens of similar mistakes.

And these kinds of mistakes aren't just limited to those older cases. Look at [Perry v. Leeke (488 U.S. 272)](/courts/ussc/?term=1988-10&case=87-6325). It was decided January 10, 1989, but SCDB lists the decision date as "1/1/1989".

There is also another, subtler problem with cases listed in the "Dates of Supreme Court Decisions and Arguments" document: the decision date of a number of cases could not be precisely identified, even by the Supreme Court's librarian, so only the date of the term was listed. This occurred, for example, in [Welsh v. Mandeville (9 U.S. 321)](/courts/ussc/?term=1809-02&case=1808-009), where the decision date was listed only as "Feb. term 1809".

Unfortunately, SCDB appears to have morphed such dates into the first day of the first month of the term, resulting in a date (e.g., February 1, 1809) that appears to be precise but is almost certainly incorrect.

NOTE: As a public service, I have extracted all the decision dates *and* argument dates from the Supreme Court's [Dates of Supreme Court Decisions and Arguments](/courts/ussc/sources/reports/Dates_of_Decisions_and_Arguments-2018-12-26.pdf) and produced an easy-to-use
[spreadsheet](/data/ussc/dates.csv). I recommend using this file instead of the one on the [Free Law](https://free.law/2011/05/25/updated-scotus-dates/) website, because the last time I checked, the dates in their file were badly scrambled, and it didn't include any argument dates. The dates on the first few lines of their file:

    2 U.S. 401|West v. Barnes|2|401|1791-08-17
    2 U.S. 401|Vanstophorst v. Maryland|2|401|1791-08-17
    2 U.S. 401|Oswald v. New York|2|401|1792-02-14
    ...

clearly do not match those provided in the Court's [PDF](/courts/ussc/sources/reports/Dates_of_Decisions_and_Arguments-2018-12-26.pdf).

Here's a list of all the corrections we've made to *dateDecision* in SCDB thus far, with links to the source material used, so that they can all be verified. This is a degree of transparency that you will not find on the SCDB website.

- Dewhurst v. Coulthard (3 U.S. 409): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1798-006-01) changed from Friday, February 1, 1799 to 1799-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Blair v. Miller (4 U.S. 21): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1800-006-01) changed from Friday, August 1, 1800 to 1800-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Talbot v. Ship Amelia (4 U.S. 34): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1801-002-01) changed from Saturday, August 15, 1801 to Friday, August 15, 1800 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- United States v. McDowell (8 U.S. 316): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1807-025-01) changed from Saturday, March 7, 1807 to Monday, March 7, 1808 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Dawson's Lessee v. Godfrey (8 U.S. 321): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1807-039-01) changed from Sunday, March 15, 1807 to Tuesday, March 15, 1808 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Welsh v. Mandeville (9 U.S. 321): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1808-009-01) changed from Wednesday, February 1, 1809 to 1809-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Riddle &amp; Co. v. Mandeville (10 U.S. 86): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1809-046-01) changed from Thursday, February 1, 1810 to 1810-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Ex parte Wilson (10 U.S. 52): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1809-045-01) changed from Thursday, February 1, 1810 to 1810-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Hawthorne v. United States (11 U.S. 107): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1812-007-01) changed from Thursday, February 20, 1812 to 1812-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Gracie v. Maryland Ins. Co. (12 U.S. 84): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1814-013-01) changed from Friday, February 25, 1814 to Saturday, February 19, 1814 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- The George (14 U.S. 408): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1815-041-01) changed from Saturday, March 23, 1816 to 1816-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- The Experiment (17 U.S. 84): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1819-001-01) changed from Monday, February 1, 1819 to 1819-02 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Miller v. Kerr (20 U.S. 1): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1822-019-01) changed from Friday, March 15, 1822 to Thursday, March 15, 1821 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- The Antelope (23 U.S. 66): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1825-017-01) changed from Friday, March 25, 1825 to Tuesday, March 15, 1825 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Dufau v. Couprey's Heirs (31 U.S. 170): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1832-023-01) changed from Friday, February 3, 1832 to Thursday, February 3, 1831 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Boyle v. Zacharie (31 U.S. 348): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1832-022-01) changed from Wednesday, February 1, 1832 to 1832-01 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- United States v. Huertas (34 U.S. 171): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1835-033-01) changed from Saturday, March 14, 1835 to Friday, March 14, 1834 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- United States v. Clarke (34 U.S. 168): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1835-032-01) changed from Saturday, March 14, 1835 to Friday, March 14, 1834 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Life &amp; Fire Ins. Co. of N. Y. v. Adams (34 U.S. 571): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1834-065-01) changed from Thursday, January 1, 1835 to 1835-01 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Hagan v. Foison (35 U.S. 160): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1836-041-01) changed from Friday, February 26, 1836 to 1836-01 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Ex parte Barry (43 U.S. 65): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1844-001-01) changed from Monday, January 1, 1844 to 1844-01 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Commercial Bank of Cincinnati v. Buckingham's Executors (46 U.S. 317): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1847-036-01) changed from Monday, March 15, 1847 to Friday, March 5, 1847 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Roberts v. Cooper (60 U.S. 373): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1856-057-01) changed from Thursday, March 5, 1857 to 1856-12 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Hemmenway v. Fisher (61 U.S. 255): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1858-002-01) changed from Friday, December 24, 1858 to Thursday, December 24, 1857 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- United States v. Fossatt (62 U.S. 445): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1858-069-01) changed from Friday, March 11, 1859 to Friday, March 11, 1859 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- United States v. Fossatt (62 U.S. 445): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1858-054-01) changed from Monday, February 28, 1859 to Friday, March 11, 1859 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Hogg v. Ruffner (66 U.S. 115): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1862-006-01) changed from Tuesday, December 23, 1862 to Monday, December 23, 1861 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Bronson v. Railroad Co. (67 U.S. 524): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1862-045-01) changed from Monday, March 2, 1863 to Monday, February 16, 1863 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- The Cornelius (70 U.S. 214): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1865-016-01) changed from Friday, January 26, 1866 to Monday, January 29, 1866 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Litchfield v. Railroad Co. (74 U.S. 270): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1868-040-01) changed from Thursday, February 25, 1869 to Monday, February 15, 1869 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Reeside v. United States (75 U.S. 38): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1868-090-01) changed from Sunday, April 25, 1869 to Thursday, April 15, 1869 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- The Johnson (76 U.S. 146): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1869-057-01) changed from Monday, February 21, 1870 to Monday, February 21, 1870 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Boylan v. United States (77 U.S. 58): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1869-169-01) changed from Friday, March 18, 1870 to Monday, March 28, 1870 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- HARTFORD FIRE INSURANCE COMPANY v. ISSAC VAN DUZER (76 U.S. 784n): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1869-205-01) changed from Saturday, April 30, 1870 to Monday, April 25, 1870 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Ex parte Perry (102 U.S. 183): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1880-028-01) changed from Wednesday, November 24, 1880 to Monday, November 24, 1879 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Bennecke v. Insurance Co. (105 U.S. 355): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1881-155-01) changed from Friday, March 31, 1882 to Monday, March 13, 1882 (see [Dates of Decisions](https://www.supremecourt.gov/opinions/datesofdecisions.pdf))
- Medsker v. Bonebrake (108 U.S. 66): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1881-227-01) changed from Sunday, October 1, 1882 to Monday, March 5, 1883 (see [108 U.S. 66](https://cdn.loc.gov/service/ll/usrep/usrep108/usrep108066/usrep108066.pdf))
- Stebbins v. Duncan (108 U.S. 32): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1881-225-01) changed from Sunday, October 1, 1882 to Monday, March 5, 1883 (see [108 U.S. 32](https://cdn.loc.gov/service/ll/usrep/usrep108/usrep108032/usrep108032.pdf))
- Connecticut Mut. Life Ins. Co. v. Cushman (108 U.S. 51): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1881-226-01) changed from Sunday, October 1, 1882 to Monday, March 5, 1883 (see [108 U.S. 51](https://cdn.loc.gov/service/ll/usrep/usrep108/usrep108051/usrep108051.pdf))
- The Nuestra Se&ntilde;ora de Regla (108 U.S. 92): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1881-228-01) changed from Sunday, October 1, 1882 to Monday, March 12, 1883 (see [108 U.S. 92](https://cdn.loc.gov/service/ll/usrep/usrep108/usrep108092/usrep108092.pdf))
- Western Pacific R. Co. v. United States (108 U.S. 510): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1881-229-01) changed from Sunday, October 1, 1882 to Monday, May 7, 1883 (see [108 U.S. 510](https://cdn.loc.gov/service/ll/usrep/usrep108/usrep108510/usrep108510.pdf))
- Slidell v. Grandjean (111 U.S. 412): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1883-002-01) changed from Monday, October 1, 1883 to Monday, March 3, 1884 (see [111 U.S. 412](https://cdn.loc.gov/service/ll/usrep/usrep111/usrep111412/usrep111412.pdf))
- UNITED STATES v. ALABAMA (123 U.S. 39): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1886-309-01) changed from Saturday, October 1, 1887 to Monday, October 24, 1887 (see [123 U.S. 39](https://cdn.loc.gov/service/ll/usrep/usrep123/usrep123032/usrep123032.pdf))
- ANDREWS v. CONE (124 U.S. 720): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1886-311-01) changed from Saturday, October 1, 1887 to Monday, February 20, 1888 (see [124 U.S. 720](https://cdn.loc.gov/service/ll/usrep/usrep124/usrep124694/usrep124694.pdf))
- St. Paul, M. &amp; M. R. Co. v. Wenzel (139 U.S. 23): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1890-066-01) changed from Wednesday, October 1, 1890 to Monday, March 2, 1891 (see [139 U.S. 23](https://cdn.loc.gov/service/ll/usrep/usrep139/usrep139023/usrep139023.pdf))
- Baltimore &amp; Ohio R. Co. v. Baugh (149 U.S. 368): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1892-229-01) changed from Tuesday, May 1, 1894 to Monday, May 1, 1893 (see [149 U.S. 368](https://cdn.loc.gov/service/ll/usrep/usrep149/usrep149368/usrep149368.pdf))
- Morgan Envelope Co. v. Albany Perforated Wrapping Paper Co. (152 U.S. 425): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1893-182-01) changed from Thursday, March 8, 1894 to Monday, March 19, 1894 (see [152 U.S. 425](https://cdn.loc.gov/service/ll/usrep/usrep152/usrep152425/usrep152425.pdf))
- The Elfrida (172 U.S. 186): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1898-026-01) changed from Saturday, October 1, 1898 to Monday, December 12, 1898 (see [172 U.S. 186](https://cdn.loc.gov/service/ll/usrep/usrep172/usrep172186/usrep172186.pdf))
- Independent Wireless Telegraph Co. v. Radio Corp. of America (270 U.S. 84): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1925-064-01) changed from Monday, January 11, 1926 to Monday, March 1, 1926 (see [270 U.S. 84](https://cdn.loc.gov/service/ll/usrep/usrep270/usrep270084/usrep270084.pdf))
- Indian Motocycle Co. v. United States (283 U.S. 570): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1930-075-01) changed from Monday, January 5, 1931 to Monday, May 25, 1931 (see [283 U.S. 570](https://cdn.loc.gov/service/ll/usrep/usrep283/usrep283570/usrep283570.pdf))
- Bernhardt v. Polygraphic Co. of America (350 U.S. 198): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1955-020-01) changed from Friday, January 6, 1956 to Monday, January 16, 1956 (see [350 U.S. 198](https://cdn.loc.gov/service/ll/usrep/usrep350/usrep350198/usrep350198.pdf))
- Swann v. Adams (383 U.S. 210): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1965-056-01) changed from Monday, February 28, 1966 to Friday, February 25, 1966 (see [383 U.S. 210](https://cdn.loc.gov/service/ll/usrep/usrep383/usrep383210/usrep383210.pdf))
- Whitehill v. Elkins (389 U.S. 54): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1967-014-01) changed from Thursday, November 16, 1967 to Monday, November 6, 1967 (see [389 U.S. 54](https://cdn.loc.gov/service/ll/usrep/usrep389/usrep389054/usrep389054.pdf))
- Lines v. Frederick (400 U.S. 18): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1970-006-01) changed from Thursday, November 12, 1970 to Monday, November 9, 1970 (see [400 U.S. 18](https://cdn.loc.gov/service/ll/usrep/usrep400/usrep400018/usrep400018.pdf))
- NLRB v. Nash-Finch Co. (404 U.S. 138): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1971-018-01) changed from Monday, December 6, 1971 to Wednesday, December 8, 1971 (see [404 U.S. 138](https://cdn.loc.gov/service/ll/usrep/usrep404/usrep404138/usrep404138.pdf))
- Givhan v. Western Line Consol. School Dist. (439 U.S. 410): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1978-025-01) changed from Thursday, January 4, 1979 to Tuesday, January 9, 1979 (see [439 U.S. 410](https://cdn.loc.gov/service/ll/usrep/usrep439/usrep439410/usrep439410.pdf))
- Harris v. Rivera (454 U.S. 339): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1981-017-01) changed from Friday, December 4, 1981 to Monday, December 14, 1981 (see [454 U.S. 339](https://cdn.loc.gov/service/ll/usrep/usrep454/usrep454339/usrep454339.pdf))
- Charles D. Bonanno Linen Service, Inc. v. NLRB (454 U.S. 404): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1981-024-01) changed from Monday, January 11, 1982 to Tuesday, January 12, 1982 (see [454 U.S. 404](https://cdn.loc.gov/service/ll/usrep/usrep454/usrep454404/usrep454404.pdf))
- United States v. Clark (454 U.S. 555): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1981-028-01) changed from Wednesday, January 13, 1982 to Tuesday, January 12, 1982 (see [454 U.S. 555](https://cdn.loc.gov/service/ll/usrep/usrep454/usrep454555/usrep454555.pdf))
- Dickman v. Commissioner (465 U.S. 330): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1983-037-01) changed from Tuesday, February 21, 1984 to Wednesday, February 22, 1984 (see [465 U.S. 330](https://cdn.loc.gov/service/ll/usrep/usrep465/usrep465330/usrep465330.pdf))
- Consolidated Rail Corporation v. Darrone (465 U.S. 624): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1983-046-01) changed from Friday, February 24, 1984 to Tuesday, February 28, 1984 (see [465 U.S. 624](https://cdn.loc.gov/service/ll/usrep/usrep465/usrep465624/usrep465624.pdf))
- Ake v. Oklahoma (470 U.S. 68): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1984-033-01) changed from Wednesday, February 20, 1985 to Tuesday, February 26, 1985 (see [470 U.S. 68](https://cdn.loc.gov/service/ll/usrep/usrep470/usrep470068/usrep470068.pdf))
- Old Chief v. United States (519 U.S. 172): [dateDecision](http://scdb.wustl.edu/analysisCaseListing.php?cid=1996-013-01) changed from Tuesday, January 14, 1997 to Tuesday, January 7, 1997 (see [519 U.S. 172](https://cdn.loc.gov/service/ll/usrep/usrep519/usrep519172/usrep519172.pdf))

### 4. Argument and Reargument Dates

Argument dates are equally prone to error, even in major cases such as [Brown v. Board of Education (347 U.S. 483)](/courts/ussc/?term=1953-10&case=1), which SCDB says was argued on "12/8/1952", but in fact, arguments began on December 9, 1952 and lasted three days.

In fact, many cases have been argued over a period of multiple days (and not necessarily consecutive days). An early example of this is [Talbot v. Janson (3 U.S. 133)](/courts/ussc/?term=1795-08&case=1795-006), which was argued over the course of ten days:

    Thursday, August 6, 1795
    Friday, August 7, 1795
    Saturday, August 8, 1795
    Monday, August 10, 1795
    Tuesday, August 11, 1795
    Wednesday, August 12, 1795
    Thursday, August 13, 1795
    Friday, August 14, 1795
    Tuesday, August 18, 1795
    Wednesday, August 19, 1795

This also occurs with some regularity in the "modern" era. See [American Trucking Associations, Inc. v. Atchison, Topeka & Santa Fe Railway Company (387 U.S. 397)](/courts/ussc/?term=1966-10&case=57), which was argued:

    Thursday, April 13, 1967
    Monday, April 17, 1967

However, recording all the dates of an oral argument (or even just the *number* of argument days) didn't seem to interest Harold Spaeth much, because his "ALLCOURT" database (SCDB's predecessor) provided only an `ORAL` field for the first date of argument.

Despite my best efforts ten years ago to convince SCDB to consider broader research interests and to at least *enable* the coding of all argument dates for a case, all they did was rename Spaeth's variable to [dateArgument](https://scdb.la.psu.edu/online-codebook/date-of-oral-argument/) and continue the old practice, without justification:

> On some occasions, oral argument extended over more than a single day. In such cases, only the first date is specified.

NOTE: For the record, SCDB incorrectly reports that [387 U.S. 397](/courts/ussc/?term=1966-10&case=57) was argued on March 13, 1967, so we have more than a completeness problem -- we have the usual accuracy problems as well.

Then there's the problem of multiple rearguments. Once again, the Spaeth "ALLCOURT" database dealt with this, but in the same limited fashion, by providing a single `REORAL` field, and SCDB followed suit with its [dateRearg](https://scdb.la.psu.edu/online-codebook/date-of-reargument/) variable:

> On those infrequent occasions when the Court orders that a case be reargued, this variable specifies the date of such argument following the same day, month, and year sequence used in the preceding variable (dateArgue [sic]).

The limitation here is even worse than before, because not only can a reargument span multiple days, but there can also be *multiple* rearguments. Take a look at [Boyle v. Landry (401 U.S. 77)](/courts/ussc/?term=1970-10&case=4). The second reargument on November 16, 1970 is nowhere to be found in SCDB.

SCDB also doesn't comprehensively list cases that were granted, argued, and then dismissed without an opinion. This can happen when the Court "DIGs" (dismisses as improvidently granted) a case, or when it dismisses a case that has later become moot. To be clear, I'm referring to cases that were fully briefed and argued and *then* dismissed, which makes them significantly different from the many petitions that are routinely denied, as well as the occasional petition that is granted and then dismissed before argument.

This is not to say that SCDB doesn't track *any* DIG'ed cases, but merely that its recording of them is haphazard. For example, [Stiles v. United States (393 U.S. 219)](/courts/ussc/?term=1968-10&case=74), argued November 20, 1968, is not listed in SCDB, while [Ford Motor Co. v. McCauley (537 U.S. 1)](/courts/ussc/?term=2002-10&case=01-896), argued October 7, 2000, is listed. The failure to record all such cases frustrates a variety of research, such as the accurate tracking of oral argument activity, the frequency of DIGs, etc.

As an aside, it's also not a simple matter to identify *just* DIG'ed cases. SCDB has a [caseDisposition](https://scdb.la.psu.edu/online-codebook/disposition-of-case/) variable that is generally set to 9 ("petition denied or appeal dismissed") in such cases, but that value is also used in other cases, such as [Schwarz v. National Security Agency (526 U.S. 122)](/courts/ussc/?term=1998-10&case=98-7771), where the case was granted and a *per curiam* opinion was issued denying petitioner's motion.

### 5. Natural Courts

A [Natural Court](https://scdb.la.psu.edu/online-codebook/natural-court/), as the SCDB online codebook explains, is:

> [A] period during which no personnel change occurs. Scholars have subdivided them into
> "strong" and "weak" natural courts, but no convention exists as to the dates on which they
> begin and end. Options include 1) date of confirmation, 2) date of seating, 3) cases decided
> after seating, and 4) cases argued and decided after seating. A strong natural court is
> delineated by the addition of a new justice or the departure of an incumbent. A weak natural
> court, by comparison, is any group of sitting justices even if lengthy vacancies occurred. 

Although one could quibble with the SCDB's natural court definitions (which I'm sometimes tempted to do), the larger problem is the accuracy of the dates for the courts that SCDB has chosen.

For example, it lists the transition between the Warren and Burger courts like so:

    1411	Warren 11	May 14, 1969 - June 22, 1969
    1501	Burger 1	June 23, 1969 - June 08, 1970

However, SCDB also lists a series of decisions handed down on June 23, 1969:

    1969-06-23: North Carolina v. Pearce [413,418] (395 U.S. 711)
    1969-06-23: Chimel v. California [770] (395 U.S. 752)
    1969-06-23: Benton v. Maryland [201] (395 U.S. 784)
    1969-06-23: Von Cleef v. New Jersey [837] (395 U.S. 814)
    1969-06-23: Shipley v. California [540 Misc.] (395 U.S. 818)
    1969-06-23: Moya v. DeBaca [996 Misc.] (395 U.S. 825)

And while it would be very impressive for the Court to hand down *six* decisions on the *first* day under a new Chief Justice, the reality is that June 23, not June 22, was Chief Justice Earl Warren's last day.

And this mistake with the "Warren 11" court isn't an isolated "one-off". There are similar problems with the "Warren 4", "Warren 5", "Warren 6", and "Warren 7" courts, not to mention "Stone 2" or "Rehnquist 1", among others.

And this isn't merely a problem with the natural court dates. Numerous cases are filed under one natural court even though they were decided under another.

Look at [Braverman v. United States (317 U.S. 49)](/courts/ussc/?term=1942-10&case=43). It was argued on October 21, 1942 and decided on November 9, 1942, which would put it squarely in SCDB's "Stone 1" natural court. But it's coded in SCDB as being in the "Stone 2" (1202) natural court.

### 6. Terms

How SCDB defines the [Term](https://scdb.la.psu.edu/online-codebook/term-of-court/) in which a case was decided is problematic: it uses a simple number (a year), which is insufficient to properly identify the *actual* term in which a case was decided.

Specifically, until 1802, there were *two* terms per year. This is why my project has adopted a string format for Supreme Court terms ("YYYY-MM") rather than an ambiguous numeric format (YYYY).

The ambiguity didn't stop in 1802 either. In 1844, there were two terms as well, because after the normal January 1844 term began, the Act of June 1844 changed the start of subsequent terms to December. Apparently out of habit, U.S. Reports still called these terms "January Terms", but that didn't change the fact that, beginning in December 1844, the Court started churning out new opinions.

SCDB, on the other hand, ignores the actual dates that the Court operated, and instead pretends that the Court's work started every January -- up until 1850, when U.S. Reports finally changed its "term-inology". As a result, SCDB implies there two terms in 1850, when in fact, there were not.

SCDB apologists could argue that, as long as the ambiguity of the **Term** variable is properly documented, researchers can work around its limitations by also examining the **dateDecision** variable and checking for all the above conditions. Of course, the logical extension of that argument would be to eliminate the **Term** variable entirely, because obviously the precise term of *any* case can be determined by applying a complicated set of rules to **dateDecision**.

Harold Spaeth's `TERM` variable didn't suffer from this ambiguity, because his "ALLCOURT" database didn't deal with cases before the Warren Court; however, there have also been a number of Special Terms, both before and after the Warren Court, which even the "ALLCOURT" database failed to properly deal with.

### 7. Undocumented Values

There are some variables, such as [caseOrigin](https://scdb.la.psu.edu/online-codebook/origin-of-case/) containing undocumented values (e.g., 157, 158, 161, etc).

And then there's [lawMinor](https://scdb.la.psu.edu/online-codebook/legal-provision-minor-supplement/), a free-form string that has become very problematic, and the values of which the Codebook does not even attempt to enumerate.

Here's a small subset of the values, to give you a sense of the problems:

    "unidentifed act of congress",
    "unidentifed act of congress, 1828",
    "unidentifiable",
    "unidentified",
    "unidentified 1807 act of congress",
    "unidentified act of congeress",
    "unidentified act of congress",
    "unidentified act of Congress of 1824",
    "unidentified act of congress, 1824, sec. 32",
    "unidentified acts of congress",
    "unidentified federal statute",
    "unidentified law",
    "unidentified patent law, sec. 15",
    "unidentified RS",
    "unidentified sdtatute",
    "unidentified statute",
    "unidentified US laws",
    "unidentified US statute",
    "Uniformed Services Former Spouses' Protection Act 10 U.S.C. 1408",
    "unknown",
    "unpaid opium tax",
    "unrestricted sale of allotments",
    "unspecified",
    "UNSPECIFIED",
    "unspecified act of congress",

There are *lots* of duplicate values, varying only in form, not in substance, as well as *lots* of typos.

### 8. Missing Cases

When cross-referencing the cases in SCDB with other reputable sources (eg, data extracted from the Supreme Court's Case Citation Finder), I've also come across a number of cases which, even though they were considered "cite-worthy", do not appear in SCDB.

I've logged some of those instances on my website (e.g., [missing cases](https://github.com/jeffpar/lonedissent/blob/master/logs/missingCases.csv) and [unknown citations](https://github.com/jeffpar/lonedissent/blob/master/logs/unknownCitations.csv)). I realize there are many "back of the book" cases that don't merit attention (e.g. denials of cert), but that's not true in *all* such cases, so perhaps SCDB should consider creating a second much simpler table of cases that cites all the cases it has deliberately omitted.

### 9. Undocumented Changes

This is a broad category, encompassing every field of every record, and it's best illustrated with a simple example.

The case [Ableman v. Booth (59 U.S. 479)](/courts/ussc/?term=1855-12&case=35) is recorded in SCDB with an argument date of "1856-01-04". This is at odds with the argument data reported in the Supreme Court's "Dates of Supreme Court Decisions and Arguments" document, which reports *no* argument date for that case. Remember, that's the document that SCDB *explicitly* says it relies on for dates in early cases such as this.

One interpretation is that this is simply an SCDB error, in which case the argument date should be deleted from the next release. However, typos typically manifest themselves as a mistake in one or two digits, not as an entirely new value appearing out of nowhere.

Another interpretation is that SCDB, relying on some other (unspecified) primary source, discovered that the case had *indeed* been argued on January 4, 1856. We have *no idea* which is the correct answer. It's also quite likely that, at this moment, no one working on SCDB knows the correct answer either.

This reminds me of email conversations I had with one of the SCDB principals, Andrew D. Martin, many years ago, when the SCDB was still in its infancy. For example, on November 3, 2009, I had written to him:

    I just performed a quick comparison of 2009 Release 03 to Release 02
    and found 173 discrete differences (after removing all the differences
    due to the LED citation format change from "L. Ed. 2d." to "L. Ed. 2d").
    Of those 173, many were to fix the incorrect LED references to Vol 1.
    of L. Ed., leaving a handful of changes/corrections to assorted cases
    (eg, the voting data in 04-607).

    I would urge you to provide more detailed release notes for your quarterly
    releases, particularly if one of the goals of these major updates is to
    support methodical scholarly research. The only release notes I could find
    for 2009 Release 03 said "Minor corrections". That level of detail seems
    inadequate to me. Even changes that seem relatively minor (eg, "L. Ed. 2d")
    are worth pointing out, since any change can cause unexpected side-effects.

His response:

    We appreciate this repeated suggestions ... and it's under consideration.
    However, our time and resources are quite limited, and repeatedly making the
    same request is, frankly, not helpful. All versions of our binary data
    files are posted (something Harold was not doing with ALLCOURT) and you can
    perform the differentials just as well as we can.

    Best,
    ADM

It's a bit sad to see that, even today, the release notes regarding any changes to existing data still say nothing more than:

    Minor corrections

The assertion that end-users "can perform the differentials just as well as we can" is absolutely true *and* absolutely beside the point, because it isn't just the "differentials" we care about, but also *where* new data came from. Without that, future researchers run the risk of tripping over the same discredited data, misunderstanding how old voting data was collected or interpreted, and so on.

## Epilogue

I long ago advocated for greater transparency in what SCDB chooses to add or correct in its database, including change logs with every release. These days, an even better step forward for SCDB would be to do what I've done here, which is to create an open-source repository containing copies of all the data sources being used, along with the scripts used to process them.

Issues like those with [Terms](#6-terms) arose simply because SCDB didn't fully consider the impact of older cases on a design that it inherited from Harold Spaeth's "ALLCOURT" database. Other issues, like those with [Argument and Reargument Dates](#4-argument-and-reargument-dates), have long been acknowledged as limitations, but the only headway we ever made was a vague commitment to consider "database extensions" that would allow groups like Oyez to add more comprehensive oral argument information (e.g., dates, names of advocates, etc). As far as I can tell, that never happened.

In any event, it's never too late to fix problems. Instead of making excuses, justifications, or brushing off good suggestions as "too much work", SCDB should start acknowledging problems and create a roadmap for improving and evolving the database, defining new variables to address old issues and new features, deprecating problematic variables, and above all, adding rigorous data validation rules and cross-checks to eliminate mistakes and prevent future errors.

As an academic endeavour, more information and transparency -- not less -- should be one of the goals, as well as encouraging cooperation and participation among all interested parties.

### Citing to the SCDB

Since we use the SCDB, we shall cite it. In fact, we shall go one step better, and *recite* their [instructions](https://scdb.la.psu.edu/how-to-cite-us/) on how one should cite it:

> To cite to the Supreme Court Database, please employ either of the following:

    Harold J. Spaeth, Lee Epstein, Andrew D. Martin, Jeffrey A. Segal,
    Theodore J. Ruger, and Sara C. Benesh. 2018 Supreme Court Database,
    Version 2018 Release 02. URL: http://Supremecourtdatabase.org 

    Harold J. Spaeth, Lee Epstein, et al. 2018 Supreme Court Database,
    Version 2018 Release 2. URL: http://Supremecourtdatabase.org 

> Please be sure to include the specific Version Number; e.g., 'Version 2018 Release 02' in your citation as this will indicate the particular version of the database being employed at the time of your reference. This matter is of great importance as the database will be updated with newly announced decisions, corrections, and the addition of new data for existing cases.

Note that indicating which release you are using is a matter "*of great importance*".
    
Which is puzzling, since SCDB consistently refuses to describe, list, or otherwise explain exactly how any release differs from any other release -- other than noting when a new batch of term data has been added. Any other differences are invariably described as nothing more than "minor corrections" -- which can't be right if they are also "of great importance".
