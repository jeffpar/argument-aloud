---
title: Argument Aloud
layout: home
---

<style>
.hp-hero {
  text-align: center;
  padding: 0 0 32px;
  max-width: 620px;
  margin: 0 auto;
}
.hp-hero h1 {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 10px;
  letter-spacing: -0.01em;
  border: none;
}
.hp-tagline {
  font-size: 0.93rem;
  line-height: 1.55;
  opacity: 0.72;
  margin: 0 0 12px;
}
.hp-example {
  font-size: 0.8rem;
  color: rgba(51, 51, 51, 0.55);
  margin: 0;
}
.hp-example a,
.hp-footer a {
  color: #2672b4;
}
.hp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  max-width: 1140px;
  margin: 0 auto 40px;
}
.hp-card {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 18px 18px 16px;
  border-radius: 10px;
  border: 1px solid #e0e4ea;
  background: #fff;
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.15s, border-color 0.15s;
}
/* Makes the whole card a real, crawlable/copyable link (browsers show its href
   on hover, and "copy link"/open-in-new-tab work), while the <a> tags inside
   .hp-card-desc still resolve to their own href — those sit above this
   full-card overlay via z-index, everything else falls through to it. */
.hp-card-link {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.hp-card:hover {
  box-shadow: 0 4px 18px rgba(0,0,0,0.09);
  transform: translateY(-2px);
  border-color: #b8c4d8;
  text-decoration: none;
  color: inherit;
}
.hp-icon {
  font-size: 1.6rem;
  line-height: 1;
  margin-bottom: 10px;
}
.hp-card-title {
  font-size: 0.93rem;
  font-weight: 700;
  color: #2672b4;
  margin-bottom: 6px;
}
.hp-card-desc {
  font-size: 0.77rem;
  line-height: 1.55;
  color: #6c6c6c;
  flex: 1;
  margin: 0;
}
.hp-card-desc a {
  position: relative;
  z-index: 1;
  color: #2672b4;
  text-decoration: none;
}
.hp-card-desc a:hover {
  text-decoration: underline;
}
.hp-footer {
  text-align: center;
  font-size: 0.77rem;
  color: rgba(51, 51, 51, 0.45);
  padding-bottom: 16px;
}
.hp-footer-sub {
  display: block;
  margin-top: 8px;
}
@media (prefers-color-scheme: dark) {
  .hp-card           { background: #1e2130; border-color: #2d2f38; }
  .hp-card:hover     { border-color: #454a5a; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
  .hp-card-title     { color: #5eaee0; }
  .hp-card-desc      { color: #9da0a8; }
  .hp-card-desc a    { color: #5eaee0; }
  .hp-example        { color: rgba(208, 211, 220, 0.55); }
  .hp-example a,
  .hp-footer a       { color: #5eaee0; }
  .hp-footer         { color: rgba(208, 211, 220, 0.45); }
}
html[data-theme="dark"]  .hp-card           { background: #1e2130; border-color: #2d2f38; }
html[data-theme="dark"]  .hp-card:hover     { border-color: #454a5a; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
html[data-theme="dark"]  .hp-card-title     { color: #5eaee0; }
html[data-theme="dark"]  .hp-card-desc      { color: #9da0a8; }
html[data-theme="dark"]  .hp-card-desc a    { color: #5eaee0; }
html[data-theme="dark"]  .hp-example        { color: rgba(208, 211, 220, 0.55); }
html[data-theme="dark"]  .hp-example a,
html[data-theme="dark"]  .hp-footer a       { color: #5eaee0; }
html[data-theme="dark"]  .hp-footer         { color: rgba(208, 211, 220, 0.45); }
html[data-theme="light"] .hp-card           { background: #fff; border-color: #e0e4ea; }
html[data-theme="light"] .hp-card:hover     { border-color: #b8c4d8; }
html[data-theme="light"] .hp-card-title     { color: #2672b4; }
html[data-theme="light"] .hp-card-desc      { color: #6c6c6c; }
html[data-theme="light"] .hp-card-desc a    { color: #2672b4; }
html[data-theme="light"] .hp-example        { color: rgba(51, 51, 51, 0.55); }
html[data-theme="light"] .hp-example a,
html[data-theme="light"] .hp-footer a       { color: #2672b4; }
html[data-theme="light"] .hp-footer         { color: rgba(51, 51, 51, 0.45); }
</style>

<div class="hp-hero">
  <h1>Argument Aloud</h1>
  <p class="hp-tagline">{{ site.description }}</p>
  <p class="hp-example">See it in action: <a href="/courts/ussc/?term=2025-10&case=24-1260&turn=369">Watson v. Republican National Committee (No.&nbsp;24-1260)</a></p>
</div>

<div class="hp-grid">

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?term=all" aria-label="Cases"></a>
    <div class="hp-icon">⚖️</div>
    <div class="hp-card-title">Cases</div>
    <p class="hp-card-desc">Browse cases from the earliest argued case in <a href="/courts/ussc/?term=1791-08&case=1791-001">1791</a> to the <a href="/courts/ussc/?term=2025-10">Present</a>. Where available, cases include all supporting materials, and of course, the Court's final decision.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?collection=gallery" aria-label="Justices"></a>
    <div class="hp-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:1.6rem;height:1.6rem" fill="#c8955c"><rect height="20" transform="matrix(0.7075 -0.7067 0.7067 0.7075 -5.6854 13.7194)" width="4" x="11.73" y="3.73"/><rect height="8" transform="matrix(0.707 -0.7072 0.7072 0.707 0.3157 11.246)" width="4" x="11.73" y="1.24"/><rect height="8" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -8.1722 7.7256)" width="4" x="3.24" y="9.73"/></svg></div>
    <div class="hp-card-title">Justices</div>
    <p class="hp-card-desc">Visit a gallery of statistics, including <a href="/courts/ussc/?collection=gallery&sort=years&o=d">Years of Service</a> or <a href="/courts/ussc/?collection=gallery&sort=vocal&o=d">Hours Spoken</a> in oral arguments, as well as all the <a href="/courts/ussc/?collection=opinions">Opinions</a> and <a href="/courts/ussc/?collection=lone_dissents">Lone Dissents</a> the justices have written.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?collection=top100_advocates" aria-label="Advocates"></a>
    <div class="hp-icon">🎙️</div>
    <div class="hp-card-title">Advocates</div>
    <p class="hp-card-desc">Survey the <a href="/courts/ussc/?collection=top100_advocates">Top 100 Advocates</a>, or all the <a href="/courts/ussc/?collection=women_advocates">Women</a> or <a href="/courts/ussc/?collection=justice_advocates">Justices</a> who have argued cases. Some have even received <a href="/courts/ussc/?collection=top100_advocates&id=edwin_s_kneedler&highlight=1">Special Recognition</a> for their service.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?term=2025-10&case=24-109" aria-label="Transcripts"></a>
    <div class="hp-icon">✏️</div>
    <div class="hp-card-title">Transcripts</div>
    <p class="hp-card-desc">Read through <a href="/courts/ussc/?collection=transcripts&group=1">Historical</a> transcripts, or follow along in recorded arguments. Correct speakers or text directly in the browser (see <strong>Transcripts</strong> in the menu above).</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?collection=all" aria-label="Collections"></a>
    <div class="hp-icon">📚</div>
    <div class="hp-card-title">Collections</div>
    <p class="hp-card-desc">Sift through historical <a href="/courts/ussc/?collection=briefs&group=1">Briefs</a>, <a href="/courts/ussc/?collection=transcripts&group=1">Transcripts</a>, and <a href="/courts/ussc/?collection=orig&group=1">Original Jurisdiction Cases</a>, or peruse third-party collections, like the <a href="/courts/ussc/?collection=scgh">Supreme Court's Greatest Hits</a>.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?topic=all" aria-label="Topics"></a>
    <div class="hp-icon">🗂️</div>
    <div class="hp-card-title">Topics</div>
    <p class="hp-card-desc">Explore cases by topic, such as <a href="/courts/ussc/?topic=nlra&group=1">The National Labor Relations Act</a> or <a href="/courts/ussc/?topic=racial&group=1">Segregation</a>, or view <a href="/courts/ussc/?topic=noteworthy">Noteworthy</a> cases by constitutional provisions and more.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?term=all&find=%3F" aria-label="Searches"></a>
    <div class="hp-icon">🔍</div>
    <div class="hp-card-title">Searches</div>
    <p class="hp-card-desc">Search cases by <a href="/courts/ussc/?term=all&find=%2323-1197">Number</a>, <a href="/courts/ussc/?term=all&find=Miranda">Title</a>, <a href="/courts/ussc/?term=all&find=%23Orig">Docket</a>, or <a href='/courts/ussc/?term=all&find="elbow+grease"'>Text</a>. Better yet, find that reference to "<a href='/courts/ussc/?term=all&find=%22broccoli%22+scalia'>Broccoli</a>" by <a href="/courts/ussc/?collection=gallery&id=antonin_scalia">Justice Scalia</a> you've heard so much about.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?term=2025-10&case=24-1260&turn=369" aria-label="Links"></a>
    <div class="hp-icon">🔗</div>
    <div class="hp-card-title">Links</div>
	<p class="hp-card-desc">Click <a href="/courts/ussc/?term=1965-10&case=759">Miranda</a> to see links to cited cases in the transcript. <strong>Tags</strong> show related cases, <strong>Speakers</strong> show other arguments, and <strong>Dates</strong> are windows onto other events.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc?collection=all" aria-label="Tags"></a>
    <div class="hp-icon">🔖</div>
    <div class="hp-card-title">Tags</div>
    <p class="hp-card-desc">Mark cases as <strong>Favorites</strong> or apply your own <strong>Tags</strong>. Export your selections at any time for safekeeping or to share. Nothing is stored remotely, everything is saved in your browser.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc?source=all" aria-label="Sources"></a>
    <div class="hp-icon">🏛️</div>
    <div class="hp-card-title">Sources</div>
    <p class="hp-card-desc">Only trusted sources of data are used, starting with the <a href="/courts/ussc/?source=ussc">U.S. Supreme Court</a>, the <a href="/courts/ussc/?link=/nara">National Archives</a>, the <a href="/courts/ussc/?source=oyez">Oyez Project</a>, and other scholarly work.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="https://github.com/jeffpar/argument-aloud" aria-label="Repositories"></a>
    <div class="hp-icon">🐙</div>
    <div class="hp-card-title">Repositories</div>
    <p class="hp-card-desc">This site is built from open-source repositories stored on GitHub.  Anyone is welcome to collaborate, but if you're feeling reclusive, fork it and do your own thing.</p>
  </div>

  <div class="hp-card">
    <a class="hp-card-link" href="/courts/ussc/?action=randomize&start=1955-10" aria-label="Surprise!"></a>
    <div class="hp-icon">🎲</div>
    <div class="hp-card-title">Surprise!</div>
    <p class="hp-card-desc">Let the dice decide &mdash; jump to a randomly selected case from anywhere in the Court&rsquo;s history. A great way to stumble across something you would never have searched for.</p>
  </div>

</div>

<p class="hp-footer">
  <a href="https://github.com/jeffpar/argument-aloud">GitHub</a>
  &nbsp;&middot;&nbsp;
  <a href="/courts/ussc/feeds/podcast.xml">Subscribe (RSS)</a>
  &nbsp;&middot;&nbsp;
  <a href="podcast://argumentaloud.org/courts/ussc/feeds/podcast.xml">Apple Podcasts</a>
  <span class="hp-footer-sub">Questions or suggestions? <a href="mailto:admin@argumentaloud.org">Contact us</a></span>
</p>
