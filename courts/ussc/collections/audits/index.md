---
layout: pane
title: "Audits"
cards:
  - title: "Missing Audio"
    desc: "Cases that <em>should</em> have audio but don't."
    href: "/courts/ussc/?collection=audits&id=missing-audio"
  - title: "Unaligned Audio"
    desc: "Audio files that don't have a transcript, or <em>do</em> but it's unaligned."
    href: "/courts/ussc/?collection=audits&id=unaligned-audio"
  - title: "Unidentified Speakers"
    desc: "Audio files that have aligned transcripts but with one or more unknown speakers."
    href: "/courts/ussc/?collection=audits&id=unidentified-speakers"
  - title: "Missing LOC Opinions"
    desc: "Cases missing an opinion in the Library of Congress <a href='https://www.loc.gov/collections/united-states-reports/'>U.S. Reports Collection</a>."
    href: "/courts/ussc/?collection=audits&id=missing-loc-opinion"
  - title: "Missing XML Opinions"
    desc: "Cases missing an opinion in the Justia <a href='https://supreme.justia.com/cases/federal/us/volume/'>U.S. Supreme Court</a> Library."
    href: "/courts/ussc/?collection=audits&id=missing-xml-opinion"
  - title: "Missing SCDB Records"
    desc: "Cases missing from the <a href='https://scdb.la.psu.edu'>Supreme Court Database</a>."
    href: "/courts/ussc/?collection=audits&id=missing-scdb-records"
  - title: "Incorrect SCDB Records"
    desc: "Cases with errors in the <a href='https://scdb.la.psu.edu'>Supreme Court Database</a>."
    href: "/courts/ussc/?collection=audits&id=incorrect-scdb-records"
  - title: "All Warnings"
    desc: "Cases with warnings, either due to problems in the <a href='https://scdb.la.psu.edu'>Supreme Court Database</a> or the U.S. Reports Collection."
    href: "/courts/ussc/?collection=audits&id=all-warnings"
---

# Audits

Browse the results of various audits we have performed and discrepancies we have flagged in other data sources.

{% include card-grid.html cards=page.cards %}
