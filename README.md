## Image Attributions

![U.S. Supreme Court Courtroom](/assets/img/default.jpg)  
[[Source](https://www.supremecourt.gov/about/photos.aspx)]

![Photograph of Supreme Court Building](/assets/img/scotus.gif)  
[[Source](https://catalog.archives.gov/id/594954)]

## Issues

 1. The transcript for [Reno v. Bossier Parish School Bd. (No. 98-405)](https://www.supremecourt.gov/oral_arguments/archived_transcripts/1998) cannot be downloaded; the URL is listed as https://www.supremecourt.gov/pdfs/transcripts/1998/98-405_98-406_04-26-1999.pdf

 2. Add support for `journal_href` (in audio entries) and `history_href` (in case entries), to provide more context regarding cases and arguments. 

 3. Note that while having both `volume` and `page` *and* `usCite` may seem redundant (which it is 99.99% of the time), there are cases like **Kaiser v. Stickney** from the 1880 term where the official citation represents the case's logical location, but the physical volume and page numbers are where the case details are *actually* printed.  That said, we should still probably eliminate `volume` and `page` from all cases where `usCite` contains the same exact information.

 4. When incorporating SCDB decision data, be aware that while a case "number" many consist of several consolidated case numbers, there are cases in some terms (eg, cases "17-1618" and "18-107" in the "2019-10" term) that were initially separate because they were argued separately but later decided together. We could add some scripting logic to merge them, or we could leave them separated and simply apply the same SCDB decision data to both cases.
