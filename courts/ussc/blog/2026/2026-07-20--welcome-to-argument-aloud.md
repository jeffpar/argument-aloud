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
  - [U.S. Reports Citation](#us-reports-citation)
  - [Transcript Text](#transcript-text)
  - [Term](#welcome-to-argument-aloud)

#### Case Title

Case title searches work using whole words. For example, if you want to find "Tinker v. Des Moines Independent Community School District", start with **tinker**.  Additional words will narrow the results (eg, **tinker school**) and the words can appear in any order (eg, **school tinker**).  Note that partial word searches are not supported (eg, **tink** will not match anything).

#### Case Number

Case number searches must start with **#** (eg, **#2**), and like word searches, partial number searches are not supported, which means if you're looking for "No. 22", you must type **#22**.  Case numbers began using 2-digit year prefixes starting with the October 1971 Term, so if you're looking for "No. 71-32", type **#71-32**.  The 2-digit year reflects the term a case was granted, not the term it was argued or decided, so never assume that case number "yy-n" will be in term "19yy" or "20yy".

Original Jurisdiction case numbers, such as "No. 45, Orig.", can be located using an "orig" suffix, as in **#45 orig** (there's none of that "22O" nonsense that the Court's [Docket Search](/courts/ussc/?source=ussc&id=docket) page uses).  As an added bonus, you can get a list of *all* Original Jurisdiction cases by simply typing **# orig**.

Miscellaneous case numbers, such as "No. 1, Misc.", can be similarly located using a "misc" suffix, as in **#1 misc**.  And as further bonus, you can get a list of *all* miscellaneous cases by simply type **# misc** -- this includes all miscellaneous orders in applications, which have case numbers such as "A-197", "09A648", etc.

Starting in October Term 1971, the Court stopped using "Misc." case numbers and began using "A-" prefixes, and then in October Term 1999, the Court switched to a "yyAn" format for applications and "yyMn" format for motions (ie, 2-digit year, followed by 'A' or 'M', followed by a number).  Interestingly, to this day however, they still use "D-" prefixes for disbarment proceedings.

#### U.S. Reports Citation

Searching by U.S. Reports citation works exactly as you would expect: type **n U.S. n** or **n US n**(eg, **347 US 483**) and the matching case(s) will be immediately listed.

Why would there ever be more than one case for a U.S. Reports citation?  Well, those citations are to a particular volume and page, and a single page *can* contain multiple decisions if they are short.  Note that some sites, such as [Justia](https://supreme.justia.com/cases/federal/us/volume/), fail to take that into account, so for any particular citation (eg, [2 U.S. 401](/courts/ussc/?term=all&find=2+us+401)), they will never list more than one case.

#### Transcript Text

Searching for a word or phrase in a transcript is done by using double-quotes, as in **"broccoli"**.  If you want to further restrict the text to a particular speaker, type their last name after the quoted text, as in **"broccoli" scalia**.

#### Term

This isn't really a *search* so much as a *shortcut*: to quickly open and browse a specific term, simply type the year of the term (eg, **1945**) and press Return.

In fact, pressing Return after *any* search is handy if you want to bookmark a particular search, or if you just want to be able to return to it using the browser's Back button.

## More To Come

The entire site is currently comprised of three open-source repositories, which are published together to provide a unified browsing experience that requires no backend database or search engine.

  - [U.S. Supreme Court Arguments](https://github.com/jeffpar/argument-aloud)
  - [U.S. Supreme Court Indexes](https://github.com/jeffpar/argument-aloud-index)
  - [U.S. Supreme Court Opinions](https://github.com/jeffpar/argument-aloud-xml)

Thoughts, suggestions, or other inquiries can be sent to [admin@argumentaloud.org](mailto:admin@argumentaloud.org).

![U.S. Supreme Court Visit](/assets/img/aa_exterior1.jpg)  
[[Repository]](https://github.com/jeffpar/argument-aloud)
