---
layout: default
---

## U.S. Supreme Court Arguments: Auditing and Oddities

Below are the results of an audit that correlated three sources of U.S. Supreme Court data for 10 terms, 1955 through 1964:

  - U.S. Supreme Court [Journals](https://www.supremecourt.gov/orders/journal.aspx)
  - U.S. Supreme Court Records at the [National Archives](https://www.archives.gov/research/guide-fed-records/groups/267.html)
  - U.S. Supreme Court Audio Recordings at [The Oyez Project](https://www.oyez.org)

The goal of this initial audit was to identify issues and work out kinks in the auditing process, and ultimately generate comprehensive lists of relevant data, including:

  - Audio present in the NARA collection but missing from the Oyez collection (and vice versa)
  - Other (non-argument) U.S. Supreme Court audio present in the NARA collection
  - Names of advocates who argued in all cases, extracted from the Journals and cross-referenced with Oyez

Ultimately, all terms from 1889 (the earliest year for which Journals are available digitally) through the present need to be audited.

Oyez omissions discovered in the initial audit:

  - [Nilva v. United States](https://www.oyez.org/cases/1956/37) (No. 37) was argued on November 8 and 13, 1956.  Oyez appears to have combined the audio recordings and inadvertently dropped the November 8 date in the process.

  - Stanton v. United States (No. 546) was argued on March 24, 1960, following a related case, Commissioner of Internal Revenue v. Duberstein  (No. 376) that was argued on March 23.  However, the argument for Stanton appears to be missing from Oyez; only the argument for [Commissioner v. Duberstein](https://www.oyez.org/cases/1959/376) is available.  The cases were decided together and reported in [363 U.S. 278](https://tile.loc.gov/storage-services/service/ll/usrep/usrep363/usrep363278/usrep363278.pdf).

  - [Presser v. United States](https://www.oyez.org/cases/1961/278) (No. 278) was argued in the 1961 term, affirmed by an equally divided Court, subsequently restored to the Court's 1962 calendar (as No. 25), and reargued and decided in the 1962 term.  However, Oyez appears to provide only the 1961 argument.

  - Creek Nation v. United States (No. 124) was argued in the 1961 term on April 24, 1962, but it does not appear in Oyez.  It was affirmed by an equally divided Court on June 4, 1962, so the lack of an opinion may have contributed to it being overlooked.

Examples of anomalies uncovered in Oyez during the initial audit:

  - Oyez filed a large number of reargued cases in the terms in which they were first argued, but with docket numbers from the terms in which they were reargued.  For example, [International Association of Machinists v. Street](https://www.oyez.org/cases/1959/4) was argued in the 1959 term as No. 258, and then redocketed and reargued in the 1960 term as No. 4, but Oyez filed it under the older term (1959) with the newer docket number (4).

  - That filing practice, in turn, resulted in terms containing multiple cases with the same docket number.  For example, [Kennedy v. Mendoza-Martinez](https://www.oyez.org/cases/1961/2) was argued in the 1961 term, reargued in the 1962 term, and filed under 1961 with its 1962 docket number (No. 2).  Unfortunately, in the 1961 term, [Metlakatla Indians v. Egan](https://www.oyez.org/cases/1961/2_0) is also No. 2.  In that case, Oyez had to resolve the filing conflict with a special suffix in the URL ("2_0").
  
  - Oyez did not consistently follow that filing practice.  For example, [Bartkus v. Illinois](https://www.oyez.org/cases/1958/1) was originally argued in the 1957 as No. 39, and then redocketed and reargued in the 1958 term as No. 1.  In this case, Oyez filed both arguments under the newer term *and* newer docket number.

  - [Garrison v. Louisiana](https://www.oyez.org/cases/1964/4) is a redocketed and reargued case in which Oyez accidentally swapped the audio for the arguments.  The case was originally docketed as No. 400 and redocketed as No. 4, but Oyez's original argument transcript begins with "Number 4, Garrison -- Jim Garrison, Appellant, versus Louisiana" and its reargument transcript begins with "Number 400, Jim Garrison, Appellant, versus Louisiana."  This type of mistake isn't something my audit looks for (my initial focus is missing or misfiled cases); I just happened to notice while looking at those particular transcripts.

  - [Hamm v. City of Rock Hill](https://www.oyez.org/cases/1964/2) combines two cases: the Hamm case (No. 2) and Lupper v. Arkansas (No. 5).  They were argued separately and decided together, which is not uncommon, but what *is* uncommon is that Oyez combined both arguments into a single audio recording.  The better (and more typical) approach is the one taken in cases like [Miranda v. Arizona](https://www.oyez.org/cases/1965/759), where multiple cases with similar facts and issues were argued together, but each case can be listened to separately.  And again, this isn't something I'm looking for, it simply caught my eye while tracking down Lupper v. Arkansas (No. 5).

  - Oyez's advocate data (ie, the names of the attorneys who argued the cases) has quite a few omissions and errors.  In many cases, names were assigned in the Oyez-generated transcripts, but for some reason, those names were not always extracted and presented on the Oyez case pages.  The Journals are a much more reliable and consistent source of advocate information, so extracting that information should result in a more accurate and comprehensive set of advocate data, as these audits continue.

With regard to docket numbers, it's worth noting that not even the Supreme Court was perfectly consistent.  For example, [Reid v. Covert](https://www.oyez.org/cases/1955/701) was assigned docket number 701 in the 1955 term, but when it was redocketed for reargument in the 1956 term, the same docket number was used.  This required the Supreme Court to add a qualifier to the docket number every time the case was mentioned in the 1956 Journal (e.g., "No. 701, October Term, 1955").  Fortunately, that was a rare occurrence, at least among argued cases, and the Court had a method for dealing with it.

The way Oyez defines a "term" created other problems.  In the modern era, a term is generally a 9 to 12-month period starting in October, but in the past, the Court sometimes had multiple "regular terms" in a single year, as well as the occasional "special term" (ie, a term sandwiched between regular terms, often in the summer).  Both regular terms and special terms are always identified by month and year (e.g., "February Term 1809", "October Term 1955", "August Special Term 1958", etc), so it would have been far better if Oyez (and others) had used unambiguous term identifiers (e.g., "YYYY-MM") instead of merely "YYYY".

Take the case of [Aaron v. Cooper, No. 1 Misc](https://www.oyez.org/cases/1957/1_misc) and its immediate successor, [Cooper v. Aaron, No. 1](https://www.oyez.org/cases/1957/1_misc), both of which Oyez filed in the 1957 term.  Those two cases were actually argued and decided *between* regular terms, in "August Special Term 1958", but given Oyez's filing limitations, it had no choice but to file them under either 1957 or 1958.  Unfortunately, each of those terms already had a case docketed as No. 1, which added to the confusion.  Oyez circumvented that confusion by creating *more* confusion: it "consolidated" both arguments under name of the latter (Cooper v. Aaron) but with the docket number of the former (No. 1 Misc).  In hindsight, the 1958 term would have a been better choice, if only because the Supreme Court listed those cases in the 1958 Journal (the Court doesn't produce separate journals for special terms).

Another anomaly arises when the Court invites *amicus* parties to argue on behalf of a *set* of cases, rather than a specific case.  For example, in the 1962 term, the following cases were argued over a period of three days:

  - [Avent v. North Carolina (No. 11)](https://www.oyez.org/cases/1962/11)
  - [Griffin v. Maryland (No. 26)](https://www.oyez.org/cases/1962/6)
  - [Lombard v. Louisiana (No. 58)](https://www.oyez.org/cases/1962/58)
  - [Gober v. Birmingham (No. 66)](https://www.oyez.org/cases/1962/66)
  - [Shuttlesworth v. Birmingham (No. 67)](https://www.oyez.org/cases/1962/67)
  - [Peterson v. Greenville (No. 71)](https://www.oyez.org/cases/1962/71)

On the third day, the Solicitor General and others then argued as *amici*, and while the Solicitor General argued with respect to *all* the cases, other attorneys (e.g., Joseph Kaufman) argued only with respect to specific cases (e.g., No. 26).  Unfortunately, Oyez didn't have an easy way to attach *amicus* arguments to multiple cases, so it simply tacked all the *amicus* arguments onto [Shuttlesworth v. City of Birmingham](https://www.oyez.org/cases/1962/67) [see November 7, 1962].  Since there are no notations to explain this, anyone looking for the complete set of arguments in another case (e.g., Griffin v. Maryland) will not know where to find the *amicus* arguments, or even that they exist.

These exceptions are what consume 90% of the time required to audit a single term.  90% of all argued cases match up perfectly between Journals, NARA records, and Oyez records -- quickly and automatically.  It's figuring out what's wrong with the remaining 10% that can take hours of sleuthing.  As the process moves forward in time, past the 1962 term, the process should improve and the number of exceptions shrink.

Working backwards before 1955, we will lose the benefit of any Oyez or NARA audio records that we can cross-reference, so the auditing process needs to incorporate other sources of data as well, such as:

  - [Library of Congress: United States Reports](https://www.loc.gov/collections/united-states-reports/)
  - [The Supreme Court Database](http://scdb.wustl.edu)

## The Supreme Court Database Revisited

As luck would have it, the very first case in this initial audit, [Texas v. New Mexico (No. 9 Orig.)](https://www.oyez.org/cases/1955/9-orig), was missing from SCDB, because even though it was argued on October 10, 1955, it was dismissed the following term, on February 25, 1957, "because of the absence of the United States as an indispensable party."  This was reported on p.166 of the 1956 Journal and in the decision at [352 U.S. 991](https://tile.loc.gov/storage-services/service/ll/usrep/usrep352/usrep352decisions/usrep352decisions.pdf#page=191).

This is another example of [frustrating inconsistencies](https://lonedissent.org/blog/2019/02/18/) with SCDB.  It does not consistently include cases that were 1) dismissed as improvidently granted ("DIG'ed"), 2) dismissed by virtue of the Court being deadlocked ("affirmed by an equally divided Court"), or 3) dismissed for any other reason, as in the case above.

[Texas v. New Mexico](https://www.oyez.org/cases/1955/9-orig) is a particularly unfortunate omission, because as The National Archives [noted](https://unwritten-record.blogs.archives.gov/2024/03/15/behind-the-scenes-providing-access-to-supreme-court-oral-arguments/):

> NARA’s holdings of Supreme Court audio recordings date to the start of the 1955 court session. The earliest recording in the collection is from the October 10, 1955 argument in the case of **Texas v. New Mexico**, an interstate water dispute which persists to modern cases and arguments before the Court.

Once a case has been granted, and *particularly* once a case has been argued, it needs to be recorded, regardless of outcome, so that researchers can identify how often cases are dismissed after being granted, why they were dismissed, and whether (and when) they were argued before being dismissed.

Cases "affirmed by an equally divided Court" are perhaps the *least* interesting cases to record, even though SCDB seems to make the *most* effort to record them, because the Court said absolutely nothing about them.  In all other dismissals, the Court provides some rationale for why it decided to dismiss, and sometimes one or more Justices will dissent, explaining why they would *not* have dismissed the case.

As an aside, I dislike the semantics of the phrase "affirmed by an equally divided Court."  Affirmance implies intention, but when the Court is deadlocked, there is no intention to affirm or reverse at all.  Using the word "affirmed" only makes sense (to me) when a case is dismissed for some stated reason (e.g., "the case dismissed as improvidently granted and the lower court ruling is affirmed.")

Here's a perfect example of a dismissed case that SCDB does not include and absolutely should have: [Hicks v. District of Columbia](https://www.oyez.org/cases/1965/51).  The decision to dismiss the case "as improvidently granted" was reported at [383 U.S. 252](https://tile.loc.gov/storage-services/service/ll/usrep/usrep383/usrep383252/usrep383252.pdf), and while the Court -- as usual in such cases -- did not bother to provide any reasons, we have the benefit of several Justices writing separately to shed some light on its reasoning.

To start, we have a brief concurrence from Justice Harlan:

> "Among the several reasons which support the action of the Court in dismissing the writ in this case as improvidently granted, I rest my decision to join in this disposition on the lack of a record, without which I do not believe the constitutional issues tendered can properly be decided."

His concurrence refers to "several reasons", only one of which he mentions (lack of a record).  Fortunately, we have a dissent from Justice Douglas that makes the Court's reasons clear: an incomplete record, and a time bar that the Court refused to waive.

"DIG'ed" cases rarely provide that much detail, and they never provide a vote, so we can't know if the decisions were unanimous or whether there were any Justices with reservations who nevertheless didn't feel strongly enough to say so.  And those decisions are typically buried in the back of U.S. Reports, along with all the other cases that were not even granted, much less briefed and argued.  **Hicks**, however, was briefed, argued, and the decision -- including the concurrence and dissent -- was prominently recorded in U.S. Reports.

{% include arguments.html term="1955" termEnd="1964" %}
