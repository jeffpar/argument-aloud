# Miscellaneous Third-Party Data

## Women Advocates

A lot of research has been done by Marlene Trestman into the history of women advocates at the U. S. Supreme Court.  A good starting point is this [Supreme Court Historical Society](https://supremecourthistory.org) article, "[Trestman’s Quest to Honor Women Advocates](https://supremecourthistory.org/society-news/trestmans-quest-to-honor-women-advocates/)", which also links to this New York Times article, "[Bessie Margolin, Lawyer Who Turned Workers’ Hopes Into Law](https://www.nytimes.com/2025/10/02/obituaries/bessie-margolin-overlooked.html?smid=nytcore-ios-share&referringSource=articleShare)".

More recently, Marlene published an article, "[Women Advocates Before the Supreme Court](https://supremecourthistory.org/oral-arguments/women-advocates-before-the-supreme-court/)", that included a Google Docs spreadsheet named [Women Advocates Through OT 24](https://docs.google.com/spreadsheets/d/1Qsu5_yl8WABum3OmNqi8wruhWXeC73n9/edit?gid=1826861058#gid=1826861058), which has been preserved [here](https://github.com/jeffpar/argument-aloud/blob/b48499ee848a389c9d6f1a2274a11c059c3424f1/courts/ussc/people/advocates/Women%20Through%20October%20Term%202024.csv).

To check for any mistakes or omissions, and to start the process of including all women who have argued since the spreadsheet was last updated, a script was created named [Audit_Women](https://github.com/jeffpar/argument-aloud/blob/main/scripts/audit_women.py) that compared the spreadsheet to all available transcript data and reported any discrepancies.  The process involved running the script, tracking down the reason for each discrepancy, correcting transcript and/or spreadsheet data as needed, re-running [Audit_Women](https://github.com/jeffpar/argument-aloud/blob/main/scripts/audit_women.py), and repeating that process hundreds of times until all the warnings were eliminated.

As part of that process, an updated copy of Marlene's spreadsheet was produced: [Women Advocates Through October Term 2024](https://github.com/jeffpar/argument-aloud/blob/main/data/misc/Women%20Advocates%20Through%20October%20Term%202024.csv).  That spreadsheet is no longer used as part of the [Update_Advocates](https://github.com/jeffpar/argument-aloud/blob/main/scripts/update_advocates.py) process, but the updated copy serves as a record of our corrections.  All 85 changes are also documented [below](#corrections-made-to-women-advocates-through-october-term-2024).

This project stores all its data as a collection of JSON files that are maintained by a set of scripts on [GitHub](https://github.com/jeffpar/argument-aloud) and presented through a web interface at [Argument Aloud](https://argumentaloud.org).  However, as a convenience, whenever [Update_Advocates](https://github.com/jeffpar/argument-aloud/blob/main/scripts/update_advocates.py) is periodically run, a new spreadsheet is generated as well:

  - [USSC Women Advocates](https://github.com/jeffpar/argument-aloud/blob/main/data/misc/ussc_women_advocates.csv)
  
That spreadsheet contains all previously available data, along with any women advocates discovered since.  As of April 22, 2026, the list of additional women includes:

  - [BEATRICE ROSENBERG](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=beatrice_rosenberg) argued on February 3, 1955 in [Lewis v. United States (No. 203)](https://argumentaloud.org/courts/ussc/?term=1954-10&case=203)
  - [HARRIET F. PILPEL](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=harriet_f_pilpel) argued on March 23, 1959 in [Farmers Educational & Cooperative Union of America v. WDAY, Inc. (No. 248)](https://argumentaloud.org/courts/ussc/?term=1958-10&case=248)
  - [HELEN G. WASHINGTON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=helen_g_washington) argued on May 18, 1959 in [Burns v. Ohio (No. 581)](https://argumentaloud.org/courts/ussc/?term=1958-10&case=581)
  - [BEATRICE ROSENBERG](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=beatrice_rosenberg) argued on November 10, 1965 in [United States v. Johnson (No. 25)](https://argumentaloud.org/courts/ussc/?term=1965-10&case=25)
  - [DORIS H. MAIER](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=doris_h_maier) argued on November 16, 1965 in [California v. Buzard (No. 40)](https://argumentaloud.org/courts/ussc/?term=1965-10&case=40)
  - [RUTH V. ILES](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=ruth_v_iles) argued on November 17, 1966 in [Keyishian v. Board of Regents of Univ. of State of N. Y. (No. 105)](https://argumentaloud.org/courts/ussc/?term=1966-10&case=105)
  - [ELIZABETH WATKINS HULEN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=elizabeth_watkins_hulen) argued on January 11, 1967 in [Pierson v. Ray (No. 79,94)](https://argumentaloud.org/courts/ussc/?term=1966-10&case=79%2C94)
  - [ELIZABETH B. LEVATINO](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=elizabeth_b_levatino) argued on February 19, 1975 in [White v. Regester (No. 73-1462)](https://argumentaloud.org/courts/ussc/?term=1974-10&case=73-1462)
  - [SHIRLEY ADELSON SIEGEL](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=shirley_adelson_siegel) argued on November 27, 1979 in [Committee for Public Education and Religious Liberty v. Regan (No. 78-1369)](https://argumentaloud.org/courts/ussc/?term=1979-10&case=78-1369)
  - [CAROL ATHA COSGROVE](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=carol_atha_cosgrove) argued on April 28, 1981 in [Jones v. Helms (No. 80-850)](https://argumentaloud.org/courts/ussc/?term=1980-10&case=80-850)
  - [SUSAN K. KRELL](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=susan_k_krell) argued on December 9, 1981 in [North Haven Bd. of Educ. v. Bell (No. 80-986)](https://argumentaloud.org/courts/ussc/?term=1981-10&case=80-986)
  - [TREVA G. ASHWORTH](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=treva_g_ashworth) argued on November 28, 1984 in [National Association for the Advancement of Colored People v. Hampton County Election Commission (No. 83-1015)](https://argumentaloud.org/courts/ussc/?term=1984-10&case=83-1015)
  - [JOY B. SHEARER](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=joy_b_shearer) argued on April 21, 1987 in [Miller v. Florida (No. 86-5344)](https://argumentaloud.org/courts/ussc/?term=1986-10&case=86-5344)
  - [SUSAN R. HARRITT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=susan_r_harritt) argued on November 3, 1987 in [Vermont v. Cox (No. 86-1108)](https://argumentaloud.org/courts/ussc/?term=1987-10&case=86-1108)
  - [CAROLE M. STANYAR](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=carole_m_stanyar) argued on February 24, 1988 in [Michigan v. Chesternut (No. 86-1824)](https://argumentaloud.org/courts/ussc/?term=1987-10&case=86-1824)
  - [TERRE LEE RUSHTON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=terre_lee_rushton) argued on March 21, 1988 in [Budinich v. Becton Dickinson & Co. (No. 87-283)](https://argumentaloud.org/courts/ussc/?term=1987-10&case=87-283)
  - [BARBARA M. JARRETT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=barbara_m_jarrett) argued on October 10, 1990 in [Arizona v. Fulminante (No. 89-839)](https://argumentaloud.org/courts/ussc/?term=1990-10&case=89-839)
  - [JOAN FOWLER](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=joan_fowler) argued on February 26, 1991 in [Florida v. Bostick (No. 89-1717)](https://argumentaloud.org/courts/ussc/?term=1990-10&case=89-1717)
  - [LISA S. NELSON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=lisa_s_nelson) argued on April 19, 1994 in [Ibanez v. Florida Dept. of Business and Professional Regulation, Bd. of Accountancy (No. 93-639)](https://argumentaloud.org/courts/ussc/?term=1993-10&case=93-639)
  - [SILVIA S. IBANEZ](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=silvia_s_ibanez) argued on April 19, 1994 in [Ibanez v. Florida Dept. of Business and Professional Regulation, Bd. of Accountancy (No. 93-639)](https://argumentaloud.org/courts/ussc/?term=1993-10&case=93-639)
  - [JULIE R. O'SULLIVAN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=julie_r_osullivan) argued on October 11, 1995 in [Thompson v. Keohane (No. 94-6615)](https://argumentaloud.org/courts/ussc/?term=1995-10&case=94-6615)
  - [SUSAN V. BOLEYN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=susan_v_boleyn) argued on June 3, 1996 in [Felker v. Turpin (No. 95-8836)](https://argumentaloud.org/courts/ussc/?term=1995-10&case=95-8836)
  - [KIM L. SHEFFIELD](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=kim_l_sheffield) argued on November 3, 1997 in [United States v. Scheffer (No. 96-1133)](https://argumentaloud.org/courts/ussc/?term=1997-10&case=96-1133)
  - [BARBARA B. MCDOWELL](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=barbara_b_mcdowell) argued on October 8, 2002 in [Barnhart v. Peabody Coal Company (No. 01-705,01-715)](https://argumentaloud.org/courts/ussc/?term=2002-10&case=01-705%2C01-715)
  - [FRANNY A. FORSMAN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=franny_a_forsman) argued on November 1, 2006 in [Whorton v. Bockting (No. 05-595)](https://argumentaloud.org/courts/ussc/?term=2006-10&case=05-595)
  - [MARY H. WILLIAMS](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=mary_h_williams) argued on October 14, 2008 in [Oregon v. Ice (No. 07-901)](https://argumentaloud.org/courts/ussc/?term=2008-10&case=07-901)
  - [HELGI C. WALKER](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=helgi_c_walker) argued on March 30, 2016 in [Welch v. United States (No. 15-6418)](https://argumentaloud.org/courts/ussc/?term=2015-10&case=15-6418)
  - [AIMEE W. BROWN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=aimee_w_brown) argued on October 7, 2025 in [Barrett v. United States (No. 24-5774)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-5774)
  - [SHANNON W. STEVENSON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=shannon_w_stevenson) argued on October 7, 2025 in [Chiles v. Salazar (No. 24-539)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-539)
  - [EASHA ANAND](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=easha_anand) argued on October 8, 2025 in [USPS v. Konan (No. 24-351)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-351)
  - [JANE E. NOTZ](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=jane_e_notz) argued on October 8, 2025 in [Bost v. IL Bd. of Elections (No. 24-568)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-568)
  - [AMY M. SAHARIA](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=amy_m_saharia) argued on October 14, 2025 in [Ellingburg v. United States (No. 24-482)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-482)
  - [ASHLEY ROBERTSON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=ashley_robertson) argued on October 14, 2025 in [Ellingburg v. United States (No. 24-482)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-482)
  - [KASDIN M. MITCHELL](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=kasdin_m_mitchell) argued on October 14, 2025 in [Bowe v. United States (No. 24-5438)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-5438)
  - [JANAI NELSON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=janai_nelson) argued on October 15, 2025 in [Louisiana v. Callais (No. 24-109)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-109)
  - [ZOE A. JACOBY](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=zoe_a_jacoby) argued on October 15, 2025 in [Case v. Montana (No. 24-624)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-624)
  - [LISA S. BLATT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=lisa_s_blatt) argued on November 4, 2025 in [Coney Island Auto Parts, Inc. v. Burton (No. 24-808)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-808)
  - [SARAH E. HARRINGTON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=sarah_e_harrington) argued on November 4, 2025 in [Hain Celestial Group v. Palmquist (No. 24-724)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-724)
  - [JENNIFER D. BENNETT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=jennifer_d_bennett) argued on November 10, 2025 in [GEO Group, Inc. v. Menocal (No. 24-758)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-758)
  - [LIBBY A. BAIRD](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=libby_a_baird) argued on November 10, 2025 in [Landor v. LA DOC (No. 23-1197)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=23-1197)
  - [ERIN M. HAWLEY](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=erin_m_hawley) argued on December 2, 2025 in [First Choice Women's Resource Centers v. Platkin (No. 24-781)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-781)
  - [ALLYSON N. HO](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=allyson_n_ho) argued on December 3, 2025 in [Olivier v. City of Brandon (No. 24-993)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-993)
  - [ASHLEY ROBERTSON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=ashley_robertson) argued on December 3, 2025 in [Olivier v. City of Brandon (No. 24-993)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-993)
  - [SARAH M. HARRIS](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=sarah_m_harris) argued on December 9, 2025 in [NRSC v. FEC (No. 24-621)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-621)
  - [KATHLEEN R. HARTNETT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=kathleen_r_hartnett) argued on January 13, 2026 in [Little v. Hecox (No. 24-38)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-38)
  - [SARAH M. HARRIS](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=sarah_m_harris) argued on January 20, 2026 in [Wolford v. Lopez (No. 24-1046)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1046)
  - [AIMEE W. BROWN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=aimee_w_brown) argued on February 23, 2026 in [Havana Docks Corp. v. Royal Caribbean Cruises (No. 24-983)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-983)
  - [MORGAN L. RATNER](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=morgan_l_ratner) argued on February 23, 2026 in [Exxon Mobil Corp. v. Corporación Cimex, S.A. (No. 24-699)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-699)
  - [ANN M. SHERMAN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=ann_m_sherman) argued on February 24, 2026 in [Enbridge Energy, LP v. Nessel (No. 24-783)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-783)
  - [ERIN E. MURPHY](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=erin_e_murphy) argued on March 2, 2026 in [United States v. Hemani (No. 24-1234)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1234)
  - [SARAH M. HARRIS](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=sarah_m_harris) argued on March 2, 2026 in [United States v. Hemani (No. 24-1234)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1234)
  - [LISA S. BLATT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=lisa_s_blatt) argued on March 3, 2026 in [Hunter v. United States (No. 24-1063)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1063)
  - [ZOE A. JACOBY](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=zoe_a_jacoby) argued on March 3, 2026 in [Hunter v. United States (No. 24-1063)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-1063)
  - [KELSI B. CORKRAN](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=kelsi_b_corkran) argued on March 24, 2026 in [Noem, Sec. of Homeland v. Al Otro Lado (No. 25-5)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=25-5)
  - [JENNIFER D. BENNETT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=jennifer_d_bennett) argued on March 25, 2026 in [Flowers Foods, Inc. v. Brock (No. 24-935)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-935)
  - [TRACI L. LOVITT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=traci_l_lovitt) argued on March 25, 2026 in [Flowers Foods, Inc. v. Brock (No. 24-935)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-935)
  - [EMILY M. FERGUSON](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=emily_m_ferguson) argued on March 31, 2026 in [Pitchford v. Cain (No. 24-7351)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=24-7351)
  - [CECILLIA D. WANG](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=cecillia_d_wang) argued on April 1, 2026 in [Trump, President of U.S. v. Barbara (No. 25-365)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=25-365)
  - [ELIZABETH B. PRELOGAR](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=elizabeth_b_prelogar) argued on April 20, 2026 in [T. M. v. Univ. of MD Medical Sys. Corp. (No. 25-197)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=25-197)
  - [LISA S. BLATT](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=lisa_s_blatt) argued on April 20, 2026 in [T. M. v. Univ. of MD Medical Sys. Corp. (No. 25-197)](https://argumentaloud.org/courts/ussc/?term=2025-10&case=25-197)

### Corrections made to "Women Advocates Through October Term 2024"

All corrections (eg, fixed typos, corrected dates/citations/etc) that were made to [Women Advocates Through October Term 2024](https://github.com/jeffpar/argument-aloud/blob/main/data/misc/Women%20Advocates%20Through%20October%20Term%202024.csv) are printed below.

It's worth noting when discussing advocate appearances that the unit of measure is typically "argument", not "case".  Sometimes multiple cases are consolidated into a single argument, which can lead to some confusion and inflated numbers.  For example, [Bessie Margolin](/courts/ussc/?collection=women_advocates&id=bessie_margolin) argued only 23 times, despite having 24 cases attributed to her.

Adding to the confusion is Earl Warren's comment about her "27 [cases] in the Supreme Court" during his remarks at her retirement gala in January 1972.  While "27 cases" may be technically correct, [Bessie Margolin's](/courts/ussc/?collection=women_advocates&id=bessie_margolin) arguments in the following 3 cases included 4 *consolidated* cases:

  - [Borden v. Borella (No. 688)](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=bessie_margolin&term=1944-10&case=688) was consolidated with [10 East 40th St. Bldg v. Callus (No. 820)](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=bessie_margolin&term=1944-10&case=820)
  - [Powell v. United States Cartridge Co. (No. 96)](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=bessie_margolin&term=1949-10&case=96%2C58%2C79) was consolidated with Aaron v. Ford, Bacon & Davis, Inc. (No. 79) and Creel v. Lone Star Defense Corp. (No. 58)
  - [Maneja v. Waialua Agricultural Co. (No. 357)](https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=bessie_margolin&term=1954-10&case=357%2C358&event=1) was consolidated with Waialua Agricultural Co. v. Maneja (No. 358)

Those consolidations mean that, over a set of 27 cases, she argued 23 times.  However, we still attribute 24 *cases* to her, because in the first set of consolidated cases, the Court issued separate opinions, effectively "unconsolidating" them; see [Borden Co. v. Borella (No. 688)](https://argumentaloud.org/courts/ussc/?id=bessie_margolin&term=1944-10&case=688) and [10 East 40th Street Building, Inc. v. Callus (No. 820)](https://argumentaloud.org/courts/ussc/?id=bessie_margolin&term=1944-10&case=820).

For the sake of argument, however, "unconsolidating" two cases *after* they were argued as one does not subsequently transform one argument into two.

```
574c574
< 573,284,Julia DiCocco Dewey,"December 9, 1996","Connecticut v. Barrett, 479 U.S. 523 (1987)",1986 J.Sup. Ct. U.S. 292
---
> 573,284,Julia DiCocco Dewey,"December 9, 1986","Connecticut v. Barrett, 479 U.S. 523 (1987)",1986 J.Sup. Ct. U.S. 292
772c772
< 771,429,Jennifer L. DeAngelis,"November 30, 1993","Staples v. United States, 511 U.S. 600 (1994)",1993 J. Sup. Ct. U.S. 347
---
> 771,429,Jennifer L. De Angelis,"November 30, 1993","Staples v. United States, 511 U.S. 600 (1994)",1993 J. Sup. Ct. U.S. 347
781c781
< 780,433,Andre Diane Blalock,"March 22, 1994","Romano v. Oklahoma, 512 U.S. 1 (1994)",1993 J. Sup. Ct. U.S. 654
---
> 780,433,Andre' Diane Blalock,"March 22, 1994","Romano v. Oklahoma, 512 U.S. 1 (1994)",1993 J. Sup. Ct. U.S. 654
809c809
< 808,,Mary Beth Westmoreland (4),"December 4, 1995","Lonchar v. Thomas, 527 U.S. 314 (1996)",1995 J. Sup. Ct. U.S. 348
---
> 808,,Mary Beth Westmoreland (4),"December 4, 1995","Lonchar v. Thomas, 517 U.S. 314 (1996)",1995 J. Sup. Ct. U.S. 348
812c812
< 811,449,Barbara E. O’Connor,"February 26, 1996","Lonchar v. Thomas, 517 U.S. 314 (1996)",1995 J. Sup. Ct. U.S. 576
---
> 811,449,Barbara E. O’Connor,"February 26, 1996","United States v. Armstrong, 517 U.S. 456 (1996)",1995 J. Sup. Ct. U.S. 576
823c823
< 822,,Cornelia T.L. Pillard (5),"October 9, 1996","O’Gilvie v. United States, 519 U.S. 79 (1996)",1996 J. Sup. Ct. U.S. 165
---
> 822,-1,Cornelia T.L. Pillard (5),"October 9, 1996","O’Gilvie v. United States, 519 U.S. 79 (1996)",1996 J. Sup. Ct. U.S. 165
827c827
< 826,458,Kathleen D. Mix,"November 13, 1996","Edwards v. Balisok, 520 U.S. 641 (1996)",1996 J. Sup. Ct. U.S. 279
---
> 826,458,Kathleen D. Mix,"November 13, 1996","Edwards v. Balisok, 520 U.S. 641 (1997)",1996 J. Sup. Ct. U.S. 279
840c840
< 839,470,Marian M. Lavaudais,"January 15, 1997","Boggs v. Boggs, 520 U.S. 833 (1997)",1996 J. Sup. Ct. U.S. 461
---
> 839,470,Marian M. Livaudais,"January 15, 1997","Boggs v. Boggs, 520 U.S. 833 (1997)",1996 J. Sup. Ct. U.S. 461
853c853
< 852,,Lisa S. Blatt (2),"October 7, 1997","Bates v. Unites States, 522 U.S. 23 (1998)",1997 J. Sup. Ct. U.S. 154
---
> 852,,Lisa S. Blatt (2),"October 7, 1997","Bates v. Unites States, 522 U.S. 23 (1997)",1997 J. Sup. Ct. U.S. 154
859c859
< 858,482,Kathleen E. Peterson,"November 10, 1997","Trest v. Cain, 522 U.S. 87 (1997)",1997 J. Sup. Ct. U.S. 265
---
> 858,482,Kathleen E. Petersen,"November 10, 1997","Trest v. Cain, 522 U.S. 87 (1997)",1997 J. Sup. Ct. U.S. 265
863c863
< 862,,Lisa S. Blatt (3),"December 1, 1997","Regions Hospital v. Shalala, 52 U.S. 448 (1998)",1997 J. Sup. Ct. U.S. 326
---
> 862,,Lisa S. Blatt (3),"December 1, 1997","Regions Hospital v. Shalala, 522 U.S. 448 (1998)",1997 J. Sup. Ct. U.S. 326
868c868
< 867,486,Heather R. Kendall,"December 10, 1997","Alaska v. Native Village of Venetie Tribal Government, 522 U.S. 510 (1998)",1997 J. Sup. Ct. U.S. 356
---
> 867,486,Heather R. Kendall,"December 10, 1997","Alaska v. Native Village of Venetie Tribal Government, 522 U.S. 520 (1998)",1997 J. Sup. Ct. U.S. 356
882c882
< 881,492,Dianne Munns,"October 13, 1998","AT&T Corporation v. Iowa Utilities Board, 525 U.S. 366 (1999)",1998 J. Sup. Ct. U.S. 204
---
> 881,492,Diane Munns,"October 13, 1998","AT&T Corporation v. Iowa Utilities Board, 525 U.S. 366 (1999)",1998 J. Sup. Ct. U.S. 204
929c929
< 928,514,Rita LaLumia,"February 22, 2000","Johnson v. United States, 529 U.S. 694 (2000)",1999 J. Sup. Ct. U.S. 610
---
> 928,514,Rita C. LaLumia,"February 22, 2000","Johnson v. United States, 529 U.S. 694 (2000)",1999 J. Sup. Ct. U.S. 610
964c964
< 963,529,Kathleen L. Caldwell,"April 28, 2001","Pollard v. E. I. du Pont de Nemours & Company, 532 U.S. 843 (2001)",2000 J. Sup Ct. U.S. 833
---
> 963,529,Kathleen L. Caldwell,"April 23, 2001","Pollard v. E. I. du Pont de Nemours & Company, 532 U.S. 843 (2001)",2000 J. Sup Ct. U.S. 833
973c973
< 972,534,Victoria A. Brambi,"November 27, 2001","United States v. Arvizu, 534 U.S. 266 (2002)",2001 J. Sup Ct. U.S. 374
---
> 972,534,Victoria A. Brambl,"November 27, 2001","United States v. Arvizu, 534 U.S. 266 (2002)",2001 J. Sup Ct. U.S. 374
976c976
< 975,537,Claudia Center,"December 3, 2001","US Airways Inc. v. Barnett, 535 U.S. 391 (2002)",2001 J. Sup Ct. U.S. 391
---
> 975,537,Claudia Center,"December 4, 2001","US Airways Inc. v. Barnett, 535 U.S. 391 (2002)",2001 J. Sup Ct. U.S. 391
994c994
< 993,546,Gwendolyn Spivey,"April 17, 2002","United States v. Drayton, 536 U.S. 194 (2002)",2001 J. Sup Ct. U.S. 778
---
> 993,546,Gwendolyn Spivey,"April 16, 2002","United States v. Drayton, 536 U.S. 194 (2002)",2001 J. Sup Ct. U.S. 778
1015,1016c1015,1016
< 1014,559,Janis S. McLean,"January 23, 2003","Woodford v. Garceau, 538 U.S. 202 (2003)",2002 J. Sup Ct. U.S. 564
< 1015,560,Lynne S. Coffin,"January 23, 2003","Woodford v. Garceau, 538 U.S. 202 (2003)",2002 J. Sup Ct. U.S. 564
---
> 1014,559,Janis S. McLean,"January 21, 2003","Woodford v. Garceau, 538 U.S. 202 (2003)",2002 J. Sup Ct. U.S. 564
> 1015,560,Lynne S. Coffin,"January 21, 2003","Woodford v. Garceau, 538 U.S. 202 (2003)",2002 J. Sup Ct. U.S. 564
1019c1019
< 1018,,Patricia A. Millett (14),"March 24, 2003","Wiggins v. Smith, 539 U.S. 510 (2003)",2002 J. Sup Ct. U.S. 779
---
> 1018,,Patricia A. Millett (14),"March 24, 2003","Nguyen v. United States, 539 U.S. 69 (2003)",2002 J. Sup Ct. U.S. 779
1045,1046c1045,1046
< 1044,,Barbara B. McDowell (17),"February 28, 2004","Household Credit Services Inc. and MBNA American Bank v. Pfennig, 541 U.S. 232 (2004)",2003 J. Sup Ct. U.S. 610
< 1045,576,Sylvia A. Goldsmith,"February 28, 2004","Household Credit Services Inc. and MBNA American Bank v. Pfennig, 541 U.S. 232 (2004)",2003 J. Sup Ct. U.S. 610
---
> 1044,,Barbara B. McDowell (17),"February 23, 2004","Household Credit Services Inc. and MBNA American Bank v. Pfennig, 541 U.S. 232 (2004)",2003 J. Sup Ct. U.S. 610
> 1045,576,Sylvia A. Goldsmith,"February 23, 2004","Household Credit Services Inc. and MBNA American Bank v. Pfennig, 541 U.S. 232 (2004)",2003 J. Sup Ct. U.S. 610
1049c1049
< 1048,,Ann E. Beeson (2),"March 2, 2004","Ashcroft v. American Civil Liberties Union, 535 U.S. 564 (2002)",2003 J. Sup Ct. U.S. 650
---
> 1048,,Ann E. Beeson (2),"March 2, 2004","Ashcroft v. American Civil Liberties Union, 542 U.S. 656 (2004)",2003 J. Sup Ct. U.S. 650
1053c1053
< 1052,582,Rosemary Scapicchio,"October 4, 2004","United States v. Booker, 543 U.S. 220 (2004)",2004 J. Sup Ct. U.S. 148
---
> 1052,582,Rosemary Scapicchio,"October 4, 2004","United States v. Booker, 543 U.S. 220 (2005)",2004 J. Sup Ct. U.S. 148
1067c1067
< 1066,590,Coli C. McKiever,"December 1, 2004","Rousey v. Jacoway, 544 U.S. 320 (2005)",2004 J. Sup Ct. U.S. 324
---
> 1066,590,Colli C. McKiever,"December 1, 2004","Rousey v. Jacoway, 544 U.S. 320 (2005)",2004 J. Sup Ct. U.S. 324
1079c1079
< 1078,598,Deanne E. Maynard,"March 30, 2005","Wilkinson v. Austin, 544 U.S. 74 (2005)",2004 J. Sup Ct. U.S. 766
---
> 1078,598,Deanne E. Maynard,"March 30, 2005","Wilkinson v. Austin, 545 U.S. 209 (2005)",2004 J. Sup Ct. U.S. 766
1110c1110
< 1109,612,Nina Perales,"March 1, 2006","GI Forum of Texas v. Perry, 547 U.S. 1017 (2006)",2005 J. Sup Ct. U.S. 715-716
---
> 1109,612,Nina Perales,"March 1, 2006","League of United Latin American Citizens v. Perry, 548 U.S. 399 (2006)",2005 J. Sup Ct. U.S. 715-716
1114c1114
< 1113,,Mary H. Williams (2),"March 29, 2006","Bustillo v. Johnson, 546 U.S. 1149 (2006)",2005 J. Sup Ct. U.S. 812
---
> 1113,,Mary H. Williams (2),"March 29, 2006","Sanchez-Llamas v. Oregon, 548 U.S. 331 (2006)",2005 J. Sup Ct. U.S. 812
1121c1121
< 1120,615,Linda M. Olivieri,"October 30, 2006","Williams v. Overton, 547 U.S. 1002 (2006)",2006 J. Sup Ct. U.S 294
---
> 1120,615,Linda M. Olivieri,"October 30, 2006","Jones v. Bock, 549 U.S. 199 (2007)",2006 J. Sup Ct. U.S 294
1130c1130
< 1129,,Beth S. Brinkmann (21),"January 5, 2007","Limtiaco v. Camacho, 549 U.S. 483 (2007)",2006 J. Sup Ct. U.S 523
---
> 1129,,Beth S. Brinkmann (21),"January 8, 2007","Limtiaco v. Camacho, 549 U.S. 483 (2007)",2006 J. Sup Ct. U.S 523
1149c1149
< 1148,,Beth S. Brinkmann (23),"November 18, 2007","Rowe v. New Hampshire Motor Transport Association, 552 U.S. 364 (2008)",2007 J. Sup Ct. U.S 368
---
> 1148,,Beth S. Brinkmann (23),"November 28, 2007","Rowe v. New Hampshire Motor Transport Association, 552 U.S. 364 (2008)",2007 J. Sup Ct. U.S 368
1178c1178
< 1177,,Caitlin J. Halligan (4),"November 4, 2008","USEC v. Eurodif S.A., 555 U.S. 807 (2008)",2008 J. Sup Ct. U.S 267-268
---
> 1177,,Caitlin J. Halligan (4),"November 4, 2008","United States v. Eurodif S.A., 555 U.S. 305 (2009)",2008 J. Sup Ct. U.S 267-268
1214c1214
< 1213,655,Madeleine C. Wanslee,"December 1, 2009","United States v. Gallop & Milavetz, 559 U.S. 229 (2010)",2009 J. Sup. Ct. U.S. 368
---
> 1213,655,Madeleine C. Wanslee,"December 1, 2009","United Student Aid Funds Inc. v. Espinosa, 559 U.S. 260 (2010)",2009 J. Sup. Ct. U.S. 368
1224,1225c1224,1225
< 1223,,Nicole A. Saharsky (7),"March 1, 2010","Berghuis v. Thompkins, 561 U.S. 1046 (2010)",2009 J. Sup. Ct. U.S. 619
< 1224,657,Elizabeth L. Jacobs,"March 1, 2010","Berghuis v. Thompkins, 561 U.S. 1046 (2010)",2009 J. Sup. Ct. U.S. 619
---
> 1223,,Nicole A. Saharsky (7),"March 1, 2010","Berghuis v. Thompkins, 560 U.S. 370 (2010)",2009 J. Sup. Ct. U.S. 619
> 1224,657,Elizabeth L. Jacobs,"March 1, 2010","Berghuis v. Thompkins, 560 U.S. 370 (2010)",2009 J. Sup. Ct. U.S. 619
1253,1254c1253,1254
< 1252,670,Ann O’Connell,"January 12, 2011","Kentucky v. King, 583 U.S. 452 (2011)",2010 J. Sup. Ct. U.S. 493
< 1253,671,Jamesa J. Drake,"January 12, 2011","Kentucky v. King, 583 U.S. 452 (2011)",2010 J. Sup. Ct. U.S. 493
---
> 1252,670,Ann O'Connell,"January 12, 2011","Kentucky v. King, 563 U.S. 452 (2011)",2010 J. Sup. Ct. U.S. 493
> 1253,671,Jamesa J. Drake,"January 12, 2011","Kentucky v. King, 563 U.S. 452 (2011)",2010 J. Sup. Ct. U.S. 493
1261c1261
< 1260,673,Kristina Schwartz,"March 21, 2011","Tolentino v. New York, 563 U.S. 123 (2011)",2010 J. Sup. Ct. U.S. 700
---
> 1260,673,Kristina Schwarz,"March 21, 2011","Tolentino v. New York, 563 U.S. 123 (2011)",2010 J. Sup. Ct. U.S. 700
1269c1269
< 1268,676,Karin S. Schwartz,"October 3, 2011","Douglas v. Santa Rosa Memorial Hospital, 565 U.S. 606 (2011)",2011 J. Sup. Ct. U.S. 169
---
> 1268,676,Karin S. Schwartz,"October 3, 2011","Douglas v. Independent Living Center of Southern Cal., Inc., 565 U.S. 606 (2012)",2011 J. Sup. Ct. U.S. 169
1279c1279
< 1278,,Ann O’Connell (2),"November 2, 2011","Gonzalez v. Thaler, 565 U.S. 134 (2012)",2011 J. Sup. Ct. U.S. 266
---
> 1278,,Ann O'Connell (2),"November 2, 2011","Gonzalez v. Thaler, 565 U.S. 134 (2012)",2011 J. Sup. Ct. U.S. 266
1283,1284c1283,1284
< 1282,681,Susan M. Freeman,"November 29, 2011","Hall v. United States, 566 U.S. 506 (2011)",2011 J. Sup. Ct. U.S. 357-358
< 1283,682,Anita Alvarez,"December 6, 2011","Williams v. Illinois, 567 U.S. 50 (2011)",2011 J. Sup. Ct. U.S. 379
---
> 1282,681,Susan M. Freeman,"November 29, 2011","Hall v. United States, 566 U.S. 506 (2012)",2011 J. Sup. Ct. U.S. 357-358
> 1283,682,Anita Alvarez,"December 6, 2011","Williams v. Illinois, 567 U.S. 50 (2012)",2011 J. Sup. Ct. U.S. 379
1288,1289c1288,1289
< 1287,,Leondra R. Kruger (12),"January 18, 2012","Holder v. Sawyers, 566 U.S. 583 (2012)",2011 J. Sup. Ct. U.S. 504
< 1288,,Ann O’Connell (3),"February 21, 2012","Freeman v. Quicken Loans, 566 U.S. 624 (2012)",2011 J. Sup. Ct. U.S. 594
---
> 1287,,Leondra R. Kruger (12),"January 18, 2012","Holder v. Martinez Gutierrez, 566 U.S. 583 (2012)",2011 J. Sup. Ct. U.S. 504
> 1288,,Ann O'Connell (3),"February 21, 2012","Freeman v. Quicken Loans, 566 U.S. 624 (2012)",2011 J. Sup. Ct. U.S. 594
1296c1296
< 1295,,Patricia A. Millett (31),"April 24, 2012","Salazar v. Patchak, 566 U.S. 920 (2012)",2011 J. Sup. Ct. U.S. 798
---
> 1295,,Patricia A. Millett (31),"April 24, 2012","Match-E-Be-Nash-She-Wish Band of Pottawatomi Indians v. Patchak, 566 U.S. 920 (2012)",2011 J. Sup. Ct. U.S. 798
1301c1301
< 1300,,Ann O’Connell (4),"October 9, 2012","Ryan v. Gonzales, 568 U.S. 57 (2013)",2012 J. Sup. Ct. U.S. 207
---
> 1300,,Ann O'Connell (4),"October 9, 2012","Ryan v. Gonzales, 568 U.S. 57 (2013)",2012 J. Sup. Ct. U.S. 207
1309c1309
< 1308,688,Patricia A. Gilley,"November 28, 2011","Henderson v. United States, 565 U.S. 1069 (2011)",2012 J. Sup. Ct. U.S. 356
---
> 1308,688,Patricia A. Gilley,"November 28, 2012","Henderson v. United States, 565 U.S. 1069 (2013)",2012 J. Sup. Ct. U.S. 356
1311c1311
< 1310,,Ginger D. Anders (8),"January 8, 2013","Wos v. E.M.A., 568 U.S. 627 (2013)",2012 J. Sup. Ct. U.S. 464
---
> 1310,,Ginger D. Anders (8),"January 8, 2013","Delia v. E.M.A., 568 U.S. 627 (2013)",2012 J. Sup. Ct. U.S. 464
1317c1317
< 1316,,Ann O’Connell (5),"February 20, 2013","PPL Corporation and Subsidiaries v. Commissioner of Internal Revenue, 569 U.S. 329 (2013)",2012 J. Sup. Ct. U.S. 587
---
> 1316,,Ann O'Connell (5),"February 20, 2013","PPL Corporation and Subsidiaries v. Commissioner of Internal Revenue, 569 U.S. 329 (2013)",2012 J. Sup. Ct. U.S. 587
1327c1327
< 1326,,Ann O’Connell (6),"April 23, 2013","Tarrant Regional Water District v. Herrmann, 569 U.S. 614 (2013)",2012 J. Sup. Ct. U.S. 804
---
> 1326,,Ann O'Connell (6),"April 23, 2013","Tarrant Regional Water District v. Herrmann, 569 U.S. 614 (2013)",2012 J. Sup. Ct. U.S. 804
1330c1330
< 1329,,Elaine J. Goldenberg (3),"October 7, 2013","Proskauer Rose v. Troice, 571 U.S. 377 (2014)",2013 J. Sup. Ct. U.S. 183
---
> 1329,,Elaine J. Goldenberg (3),"October 7, 2013","Chadbourne & Parke LLP v. Troice, 571 U.S. 377 (2014)",2013 J. Sup. Ct. U.S. 183
1332c1332
< 1331,,Ann O’Connell (7),"October 8, 2013","Burt v. Titlow, 571 U.S. 12 (2013)",2013 J. Sup. Ct. U.S. 186
---
> 1331,,Ann O'Connell (7),"October 8, 2013","Burt v. Titlow, 571 U.S. 12 (2013)",2013 J. Sup. Ct. U.S. 186
1336c1336
< 1335,697,Shanta Driver,"October 15, 2013","Schuette v. Coalition to Defend Affirmative Action, 572 U.S. 291 (2014)",2013 J. Sup. Ct. U.S. 218
---
> 1335,697,Shanta Driver,"October 15, 2013","Schuette v. BAMN, 572 U.S. 291 (2014)",2013 J. Sup. Ct. U.S. 218
1343c1343
< 1342,,Elaine J. Goldenberg (4),"December 10, 2013","Scialabba v. De Osorio, 573 U.S. 41 (2014)",2013 J. Sup. Ct. U.S. 396
---
> 1342,,Elaine J. Goldenberg (4),"December 10, 2013","Mayorkas v. Cuellar de Osorio, 573 U.S. 41 (2014)",2013 J. Sup. Ct. U.S. 396
1345c1345
< 1344,,Ann O’Connell Adams (8),"December 11, 2013","Lozano v. Alvarez, 572 U.S. 1 (2014)",2013 J. Sup. Ct. U.S. 397
---
> 1344,,Ann O'Connell (8),"December 11, 2013","Lozano v. Alvarez, 572 U.S. 1 (2014)",2013 J. Sup. Ct. U.S. 397
1347c1347
< 1346,,Sarah E. Harrington (9),"January 14, 2014","Law v. Siegel, 571 U.S. 415 (2014)",2013 J. Sup. Ct. U.S. 476
---
> 1346,,Sarah E. Harrington (9),"January 13, 2014","Law v. Siegel, 571 U.S. 415 (2014)",2013 J. Sup. Ct. U.S. 476
1354,1355c1354,1355
< 1353,,Melissa Arbus Sherry (10),"April 21, 2014","POM Wonderful v. The Coca-Cola Company, 573 U.S. 102 (2013)",2013 J. Sup. Ct. U.S. 764
< 1354,,Kathleen M. Sullivan (9),"April 21, 2014","POM Wonderful v. The Coca-Cola Company, 573 U.S. 102 (2013)",2013 J. Sup. Ct. U.S. 764
---
> 1353,,Melissa Arbus Sherry (10),"April 21, 2014","POM Wonderful v. The Coca-Cola Company, 573 U.S. 102 (2014)",2013 J. Sup. Ct. U.S. 764
> 1354,,Kathleen M. Sullivan (9),"April 21, 2014","POM Wonderful v. The Coca-Cola Company, 573 U.S. 102 (2014)",2013 J. Sup. Ct. U.S. 764
1362c1362
< 1361,,Ann O’Connell (9),"October 14, 2014","Kansas v. Carr, 577 U.S. _ (2016)",2014 J. Sup. Ct. U.S. 194
---
> 1361,,Ann O'Connell (9),"October 14, 2014","Kansas v. Nebraska, 577 U.S. _ (2016)",2014 J. Sup. Ct. U.S. 194
1368c1368
< 1367,,Ann O’Connell Adams (10),"November 10, 2014","T-Mobile South v. City of Roswell, Georgia, 574 U.S. 293 (2015)",2014 J. Sup. Ct. U.S. 280
---
> 1367,,Ann O'Connell (10),"November 10, 2014","T-Mobile South v. City of Roswell, Georgia, 574 U.S. 293 (2015)",2014 J. Sup. Ct. U.S. 280
1378c1378
< 1377,,Nicole A. Saharsky (22),"January 15, 2015","Mach Mining v. Equal Employment Opportunity Commission, 575 U.S. _ (2015)",2014 J. Sup. Ct. U.S. 448
---
> 1377,,Nicole A. Saharsky (22),"January 13, 2015","Mach Mining v. Equal Employment Opportunity Commission, 575 U.S. _ (2015)",2014 J. Sup. Ct. U.S. 448
1380c1380
< 1379,,Ann O’Connell (11),"February 24, 2015","Henderson v. United States, 575 U.S. _ (2015)",2014 J. Sup. Ct. U.S. 568
---
> 1379,,Ann O'Connell (11),"February 24, 2015","Henderson v. United States, 575 U.S. _ (2015)",2014 J. Sup. Ct. U.S. 568
1391c1391
< 1390,713,Mary L. Bonauto,"April 28, 2015","Bourke v. Beshear, 576 U.S. _ (2015)",2014 J. Sup. Ct. U.S. 755
---
> 1390,713,Mary L. Bonauto,"April 28, 2015","Obergefell v. Hodges, 576 U.S. _ (2015)",2014 J. Sup. Ct. U.S. 755
1393c1393
< 1392,,Rachel P. Kovner (4),"October 7, 2015","Kansas v. Carr Jr., 577 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 152
---
> 1392,,Rachel P. Kovner (4),"October 7, 2015","Kansas v. Carr, 577 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 152
1395c1395
< 1394,,Ann O’Connell (12),"November 3, 2015","Lockhart v. United States, 577 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 233
---
> 1394,,Ann O'Connell (12),"November 3, 2015","Lockhart v. United States, 577 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 233
1410c1410
< 1409,,Ann O’Connell (13),"Feb. 24, 2016`","CPV Maryland v. Talen Energy Marketing, 578 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 508
---
> 1409,,Ann O'Connell (13),"Feb. 24, 2016`","CPV Maryland v. Talen Energy Marketing, 578 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 508
1418c1418
< 1417,,Sarah E. Harrington (17),"March 29, 2016","Mark J. v. Gillie, 578 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 668
---
> 1417,,Sarah E. Harrington (17),"March 29, 2016","Sheriff v. Gillie, 578 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 668
1422c1422
< 1421,722,Kathryn Keena,"April 20, 2016","Beylund v. Levi, 579 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 740
---
> 1421,722,Kathryn Keena,"April 20, 2016","Birchfield v. North Dakota, 579 U.S. _ (2016)",2015 J. Sup. Ct. U.S. 740
1437c1437
< 1436,,Ann O’Connell (14),"November 5, 2016","Lightfoot v. Cendant Mortgage Corp., 580 U.S._ (2017)",2016 J. Sup. Ct. U.S. 250
---
> 1436,,Ann O'Connell (14),"November 8, 2016","Lightfoot v. Cendant Mortgage Corp., 580 U.S._ (2017)",2016 J. Sup. Ct. U.S. 250
1442c1442
< 1441,,Ann O’Connell (14),"January 9, 2017","Lewis v. Clarke, 581 U.S._ (2017)",2016 J. Sup. Ct. U.S. 417
---
> 1441,,Ann O'Connell (14),"January 9, 2017","Lewis v. Clarke, 581 U.S._ (2017)",2016 J. Sup. Ct. U.S. 417
1444c1444
< 1443,726,Rachel Meeropol,"January 18, 2017","Hasty v. Abbasi, 582 U.S._ (2017)",2016 J. Sup. Ct. U.S. 440
---
> 1443,726,Rachel Meeropol,"January 18, 2017","Ziglar v. Abbasi, 582 U.S._ (2017)",2016 J. Sup. Ct. U.S. 440
1451c1451
< 1450,,Lisa S. Blatt (35),"March 27, 2017","Dignity Health v. Starla Rollins, 581 U.S. _ (2017)",2016 J. Sup. Ct. U.S. 615
---
> 1450,,Lisa S. Blatt (35),"March 27, 2017","Advocate Health Care Network v. Stapleton, 581 U.S. _ (2017)",2016 J. Sup. Ct. U.S. 615
1466c1466
< 1465,,Ann O'Connell Adams (16),"November 7, 2017","Patchak v. Zinke, 583 U.S. _ (2018)",2017 J. Sup. Ct. U.S. 245
---
> 1465,,Ann O'Connell (16),"November 7, 2017","Patchak v. Zinke, 583 U.S. _ (2018)",2017 J. Sup. Ct. U.S. 245
1469c1469
< 1468,,Ann O'Connell Adams (17),"January 8, 2018",Texas v. New Mexico and Colorado (585 U.S._ (2018),2017 J. Sup. Ct. U.S. 409
---
> 1468,,Ann O'Connell (17),"January 8, 2018",Texas v. New Mexico and Colorado (585 U.S._ (2018),2017 J. Sup. Ct. U.S. 409
1476c1476
< 1475,,Ann O'Connell Adams (18),"March 21, 2018","Upper Skagit Indian Tribe v. Lundgren, 584 U.S. _ (2018)",2017 J. Sup. Ct. U.S. 600
---
> 1475,,Ann O'Connell (18),"March 21, 2018","Upper Skagit Indian Tribe v. Lundgren, 584 U.S. _ (2018)",2017 J. Sup. Ct. U.S. 600
1487c1487
< 1486,,Ann O'Connell Adams (19),"October 30, 2018","Washington State Department of Licensing v. Cougar Den, Inc., 586 U.S. _ (2019)",2018 J. Sup. Ct. U.S. 226-227
---
> 1486,,Ann O'Connell (19),"October 30, 2018","Washington State Department of Licensing v. Cougar Den, Inc., 586 U.S. _ (2019)",2018 J. Sup. Ct. U.S. 226-227
1495c1495
< 1494,,Ann O'Connell Adams (20),"January 14, 2019","Thacker v. TVA, 587 U.S. _ (2019)",2018 J. Sup. Ct. U.S. 431
---
> 1494,,Ann O'Connell (20),"January 14, 2019","Thacker v. TVA, 587 U.S. _ (2019)",2018 J. Sup. Ct. U.S. 431
1502c1502
< 1501,,Morgan L. Ratner (formerly Goodspeed) (2),"March 18, 2019","Virginia House of Delegates v. Bethune-Hill, 587 U.S. _ (2019)",2018 J. Sup. Ct. U.S. 594
---
> 1501,,Morgan L. Ratner (formerly Morgan Goodspeed) (2),"March 18, 2019","Virginia House of Delegates v. Bethune-Hill, 587 U.S. _ (2019)",2018 J. Sup. Ct. U.S. 594
1564c1564
< 1563,773,Alexa Kolbi-Molinas,"October 6, 2021",Cameron v. EMW Women's Surgical Center,Oral Argument Transcript
---
> 1563,773,Alexa Kolbi-Molinas,"October 12, 2021",Cameron v. EMW Women's Surgical Center,Oral Argument Transcript
1592,1593c1592,1593
< 1591,782,Karen R. King,"March 21, 2022",Golan v. Saada,Oral Argument Transcript
< 1592,,Colleen E.R. Sinzdak (5),"March 22, 2022",LeDure v. Union Pacific Railroad Co.,Oral Argument Transcript
---
> 1591,782,Karen R. King,"March 22, 2022",Golan v. Saada,Oral Argument Transcript
> 1592,,Colleen E.R. Sinzdak (5),"March 28, 2022",LeDure v. Union Pacific Railroad Co.,Oral Argument Transcript
1689c1689
< 1688,808,Katherine B. Wellington,"October 7, 2024","Royal Canin, USA v. Wullshleger",Oral Argument Transcript
---
> 1688,808,Katherine B. Wellington,"October 7, 2024","Royal Canin U.S.A., Inc. v. Wullschleger (No. 23-677)",Oral Argument Transcript
1698c1698
< 1697,,Melissa Arbus Sherry (12),"November 4, 2024",Advocate Christ Medical v. Becerra,Oral Argument Transcript
---
> 1697,,Melissa Arbus Sherry (12),"November 5, 2024",Advocate Christ Medical v. Becerra,Oral Argument Transcript
1722c1722
< 1721,,Sarah M. Harris (7),"March 26, 2025",Oklahoma v. EPA,Oral Argument Transcript
---
> 1721,,Sarah M. Harris (7),"March 26, 2025",FCC v. Consumers' Research,Oral Argument Transcript
```
