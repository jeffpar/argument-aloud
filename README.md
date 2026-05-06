# Argument Aloud

## For The Sake of Argument

Every U.S. Supreme Court case ends in a decision, but understanding how it started and the arguments that were made is key to understanding that decision.  This open-source project attempts to bring all those threads together and create a unified interface at [argumentaloud.org](https://argumentaloud.org).

Arguments come in many forms. There is the initial petition, and if the Court accepts it, that's followed by a series of briefs, which usually culminates in oral argument.  Oral arguments have been routinely recorded since October 1955 and routinely transcribed since October 1968.

Digital copies of all those pieces (petitions, briefs, transcripts, audio recordings, opinions, etc) are available for modern cases, but they tend to be scattered.  Even the U.S. Supreme Court's own [website](https://www.supremecourt.gov) directs you to different pages for *every* piece of information related to a case.

And there are other essential pieces of information, such as copies of statutes, records from the lower courts, and so on.  Those are often buried in one or more of the briefs (eg, joint appendices), but having links to the relevant pages in the transcripts would be even better.

You can find examples of how such links would work in a few cases here already, such as [Watson v. RNC](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1260&turn=369).

Dive in and explore!

## Issues

 1. The transcript for [Reno v. Bossier Parish School Bd. (No. 98-405)](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1998) cannot be downloaded; the URL is listed as `https://www.supremecourt.gov/pdfs/transcripts/1998/98-405_98-406_04-26-1999.pdf`

 2. loc.gov currently has copies of opinions from U.S. Reports as far forward as [Volume 578](https://www.loc.gov/search/?fa=partof:u.s.+reports:+volume+578). Unfortunately, they suffer from some sloppiness; for example, there is no entry for **Sullivan v. Florida (560 U.S. 181)**; you can only find it at the bottom of the document for [United States v. Comstock (560 U.S. 126)](https://tile.loc.gov/storage-services/service/ll/usrep/usrep560/usrep560126/usrep560126.pdf#page=56).

 3. Track down the audio for No. 8 Orig on October 10, 1978 from NARA. [Oyez](https://www.oyez.org/cases/1978/8_orig) claims no argument took place, but that can't be correct, because a [transcript](https://www.supremecourt.gov/pdfs/transcripts/1978/8_Orig_10-10-1978.pdf) exists.

 4. For some reason, Oyez has no opinion announcements for [Mahmoud v. Taylor (No. 24-297)](https://argumentaloud.org/courts/ussc/?term=2024-10&case=2024-058) or [Trump v. CASA Inc. (No. 24A884)](https://argumentaloud.org/courts/ussc/?term=2024-10&case=2024-065), just oral dissents from Justice Sotomayor.

## TODO

 1. Add support for `journal_href` (in audio entries) and `history_href` (in case entries), to provide more context regarding cases and arguments. 

## MIT License

UI, schema, and scripts (c) 2026 by Jeff Parsons

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

![U.S. Supreme Court Courtroom](/assets/img/default.jpg)  
[[Source](https://www.supremecourt.gov/about/photos.aspx)]

![Photograph of Supreme Court Building](/assets/img/scotus.gif)  
[[Source](https://catalog.archives.gov/id/594954)]
