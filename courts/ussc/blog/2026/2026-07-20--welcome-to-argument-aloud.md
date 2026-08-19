---
title: "Welcome to Argument Aloud"
layout: pane
date: 2026-07-20
permalink: /courts/ussc/blog/2026/welcome-to-argument-aloud/
default: true
---

# Welcome to Argument Aloud

*{{ page.date | date: "%A, %B %-d, %Y" }}*

This website is a hub that connects U.S. Supreme Court media (briefs, transcripts, recordings, opinions) to cases, and collects stats on the Justices and Advocates who argue them.

If you're looking for something specific, tips on [Searching](#search-tips) are provided below.  Otherwise, here are some quick links to help you dive in.

{% include card-grid.html cards=site.data.ussc.home %}

We also want to improve how all the pieces of information associated with a case are connected.  For example, here's an excerpt from the March 23, 2026 argument in [Watson v. Republican National Committee (No. 24-1260)](/courts/ussc/?term=2025-10&case=24-1260&turn=369), with links to documents that activate automatically as the argument progresses.

That example barely scratches the surface of what is possible, but hopefully it gives you some sense of what a modern UI can accomplish, and maybe it will even inspire others to "follow suit."

## Search Tips

### Searching for Cases

Use the Terms search box (activated by clicking the magnifying glass to the right of Terms, clicking the "Search" shortcut in the site menu, or pressing Ctrl-F), which allows you to search by:

  - [Case Title](#case-title)
  - [Case Number](#case-number)
  - [Case ID (SCDB)](#case-id)
  - [Citation](#us-reports-citation)
  - [Term](#term)
  - [Transcript Text](#transcript-text)
  - [On This Day](#on-this-day)

#### Case Title

Case title searches work using whole words. For example, if you want to find "Tinker v. Des Moines Independent Community School District", start with **tinker**.  Additional words will narrow the results (eg, **tinker school**) and the words can appear in any order (eg, **school tinker**).  Note that partial word searches are not supported (eg, **tink** will not match anything).

#### Case Number

Case number searches must start with **#** (eg, **#2**), and like word searches, partial number searches are not supported, which means if you're looking for "No. 22", you must type **#22**.  Case numbers began using 2-digit year prefixes starting with the October 1971 Term, so if you're looking for "No. 71-32", type **#71-32**.  The 2-digit year reflects the term a case was granted, not the term it was argued or decided, so never assume that case number "yy-n" will be in term "19yy" or "20yy".

Original Jurisdiction case numbers such as "No. 45, Orig." can be located using an "orig" suffix, as in **#45 orig** (we don't require the "22O" nonsense that the Court's [Docket Search](/courts/ussc/?source=ussc&id=docket) page uses).  As an added bonus, you can get a list of *all* Original Jurisdiction cases by simply typing **# orig**.

Miscellaneous case numbers such as "No. 1, Misc." can be similarly located using a "misc" suffix, as in **#1 misc**.  And as a further bonus, you can get a list of *all* miscellaneous cases by simply type **# misc** -- this includes all miscellaneous orders in applications, which have case numbers such as "A-197", "09A648", etc.

NOTE: Starting in October Term 1971, the Court stopped using "Misc." case numbers and began using "A-" prefixes, and then in October Term 1999, the Court switched to a "yyAn" format for applications and "yyMn" format for motions (ie, 2-digit year, followed by 'A' or 'M', followed by a number).  Interestingly however, to this day, they still use "D-" prefixes for disbarment proceedings.

#### Case ID

For users of the [Supreme Court Database (SCDB)](https://scdb.la.psu.edu) who want to search for cases by [SCDB Case ID](https://scdb.la.psu.edu/online-codebook/scdb-case-id/), precede the ID with **#**, just as you would a case number; for example, **#1953-069** will return *Brown v. Board of Education (I)*. Historically, these Case IDs have been permanent, meaning once a case is assigned an ID, it never changes; however, there is no mention or promise of this in the SCDB Codebook, so one can only hope.

Also note that our database is a superset of SCDB, so not every case here will have an ID; such cases always have a case number, which we use as a fallback.  You can see a complete list of such cases in our [Cases Missing SCDB Records](/courts/ussc/?collection=audits&id=missing-scdb-records&sort=decided&o=a) audit.

While on the subject of SCDB and case numbers, we do support searching for cases like *McConnell v. Federal Election Commission* by any of its consolidated case numbers (eg, **#02-1734**) in addition to its leading case number **#02-1674**, but we are at the mercy of SCDB accurately recording all such numbers -- which, alas, [they do not](/courts/ussc/?link=/courts/ussc/blog/2026/revisiting-the-scdb#consolidated-cases).  This is an ongoing problem which, perhaps, our Journal back-filling project may someday resolve.

#### Citation

Searching by U.S. Reports citation works exactly as you would expect: type **n U.S. n** or **n US n** (eg, **347 US 483**) and the matching case(s) will be immediately listed.

Why would there ever be more than one case for a U.S. Reports citation?  Well, those citations are to a particular volume and page, and a single page *can* contain multiple decisions if they are short.  Note that some sites, such as [Justia](https://supreme.justia.com/cases/federal/us/volume/), fail to take that into account, so for any particular citation (eg, [2 U.S. 401](/courts/ussc/?term=all&find=2+us+401)), they will never list more than one case.

#### Term

This isn't a *search* so much as a *shortcut*: to quickly open and browse a specific term, simply type the year of the term (eg, **1945**) and press Return.

In fact, pressing Return after *any* search is handy if you want to to be able to return to the search results using the browser's Back button, or to bookmark the search, share it, etc.

#### Transcript Text

Searching for a word or phrase in a transcript is done by using double-quotes, as in **"broccoli"**.  If you want to further restrict the text to a particular speaker, type their last name after the quoted text, as in **"broccoli" scalia**.

#### On This Day

The [On This Day](/courts/ussc/?link=/courts/ussc/collections/historical/onthisday/) feature isn't actually part of the Search function, but it is another type of case-related search the site can perform.  That link randomly selects a case that was either argued or decided on the current month and day at some previous point in the Court's history.

## More To Come

The entire site is currently comprised of three open-source repositories, which are published together to provide a unified browsing experience that requires no backend database or search engine.

  - [U.S. Supreme Court Arguments](https://github.com/jeffpar/argument-aloud)
  - [U.S. Supreme Court Indexes](https://github.com/jeffpar/argument-aloud-index)
  - [U.S. Supreme Court Opinions](https://github.com/jeffpar/argument-aloud-xml)

Thoughts, suggestions, or other inquiries can be sent to [admin@argumentaloud.org](mailto:admin@argumentaloud.org).

![U.S. Supreme Court Visit](/assets/img/aa_exterior1.jpg)  
[[Repository]](https://github.com/jeffpar/argument-aloud)
