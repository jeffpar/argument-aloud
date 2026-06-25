---
title: Argument Aloud
layout: home
---

<style>
.hp-hero {
  text-align: center;
  padding: 40px 0 32px;
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
  <p class="hp-tagline">A media hub that connects (almost) every U.S. Supreme Court argument with all available files (briefs, transcripts, recordings, opinions) &mdash; all in one place.</p>
  <p class="hp-example">See it in action: <a href="/courts/ussc/?term=2025-10&case=24-1260&turn=369">Watson v. RNC (No.&nbsp;24-1260)</a></p>
</div>

<div class="hp-grid">

  <div class="hp-card" data-href="/courts/ussc/?term=all">
    <div class="hp-icon">⚖️</div>
    <div class="hp-card-title">Cases</div>
    <p class="hp-card-desc">Browse cases from the earliest argued case in <a href="/courts/ussc/?term=1791-08&case=1791-001">1791</a> to the <a href="/courts/ussc/?term=2025-10">Present</a>. Where available, cases include all supporting materials, and of course, the Court's final decision.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc/?collection=gallery">
    <div class="hp-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:1.6rem;height:1.6rem" fill="#c8955c"><rect height="20" transform="matrix(0.7075 -0.7067 0.7067 0.7075 -5.6854 13.7194)" width="4" x="11.73" y="3.73"/><rect height="8" transform="matrix(0.707 -0.7072 0.7072 0.707 0.3157 11.246)" width="4" x="11.73" y="1.24"/><rect height="8" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -8.1722 7.7256)" width="4" x="3.24" y="9.73"/></svg></div>
    <div class="hp-card-title">Justices</div>
    <p class="hp-card-desc">Visit a gallery of statistics, including <a href="/courts/ussc/?collection=gallery&sort=years&o=d">Years of Service</a> or <a href="/courts/ussc/?collection=gallery&sort=vocal&o=d">Hours Spoken</a> in oral arguments, as well as all the <a href="/courts/ussc/?collection=opinions">Opinions</a> and <a href="/courts/ussc/?collection=lone_dissents">Lone Dissents</a> the justices have written.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc/?collection=top100_advocates">
    <div class="hp-icon">🎙️</div>
    <div class="hp-card-title">Advocates</div>
    <p class="hp-card-desc">Survey the <a href="/courts/ussc/?collection=top100_advocates">Top 100 Advocates</a>, or all the <a href="/courts/ussc/?collection=women_advocates">Women</a> or <a href="/courts/ussc/?collection=justice_advocates">Justices</a> who have argued cases. Some have even received <a href="/courts/ussc/?collection=top100_advocates&id=edwin_s_kneedler&highlight=1">Special Recognition</a> for their service.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc/?term=2025-10&case=24-109">
    <div class="hp-icon">✏️</div>
    <div class="hp-card-title">Transcripts</div>
    <p class="hp-card-desc">Spot an error? Correct speaker labels or transcript text directly in the browser, then download your edits for submission (see the Transcripts menu at top right).</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc/?collection=all">
    <div class="hp-icon">📚</div>
    <div class="hp-card-title">Collections</div>
    <p class="hp-card-desc">Stroll through collections of historical <a href="/courts/ussc/?collection=briefs&group=1">Briefs</a> and <a href="/courts/ussc/?collection=transcripts&group=1">Transcripts</a>. Sift through old <a href="/courts/ussc/?collection=orig">Original Jurisdicion</a> cases. Or explore third-party collections, like the <a href="/courts/ussc/?collection=scgh">Supreme Court's Greatest Hits</a>.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc?topic=all">
    <div class="hp-icon">🗂️</div>
    <div class="hp-card-title">Topics</div>
    <p class="hp-card-desc">Browse cases by topic, such as <a href="/courts/ussc/?topic=nlra&group=1">The National Labor Relations Act</a> or <a href="/courts/ussc/?topic=racial&group=1">Segregation</a> (with more to come), or view <a href="/courts/ussc/?topic=noteworthy">Noteworthy</a> cases by constitutional provisions and more.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc/?term=all">
    <div class="hp-icon">🔍</div>
    <div class="hp-card-title">Searches</div>
    <p class="hp-card-desc">Search cases by <a href="/courts/ussc/?term=all&find=%2323-1197">Number</a>, <a href="/courts/ussc/?term=all&find=Miranda">Title</a>, or <a href='/courts/ussc/?term=all&find="elbow+grease"'>Text</a>. Better yet, find that reference to "<a href='/courts/ussc/?term=2011-10&case=11-393&event=4&turn=35&find="broccoli"&speaker=scalia'>Broccoli</a>" by <a href="/courts/ussc/?collection=gallery&id=antonin_scalia">Justice Scalia</a> you've heard so much about.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc">
    <div class="hp-icon">🔗</div>
    <div class="hp-card-title">Links</div>
    <p class="hp-card-desc">As you're reading and listening to a transcript, notice that every speaker is a link, and every date is a window onto what else happened on the same day.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc">
    <div class="hp-icon">🔖</div>
    <div class="hp-card-title">Tags</div>
    <p class="hp-card-desc">Mark cases as favorites or apply your own tags. Export your selections at any time for safekeeping or to share. Nothing is stored remotely, everything is saved in your browser.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc?source=all">
    <div class="hp-icon">🏛️</div>
    <div class="hp-card-title">Sources</div>
    <p class="hp-card-desc">Only trusted sources of data are used, starting with The U.S. Supreme Court, The National Archives, The Oyez Project, and other scholarly work.</p>
  </div>

  <div class="hp-card" data-href="https://github.com/jeffpar/argument-aloud">
    <div class="hp-icon">🐙</div>
    <div class="hp-card-title">Repositories</div>
    <p class="hp-card-desc">This site is built from open-source repositories stored on GitHub.  Anyone is welcome to collaborate, but if you're feeling reclusive, fork it and do your own thing.</p>
  </div>

  <div class="hp-card" data-href="/courts/ussc/?action=randomize&start=1955-10">
    <div class="hp-icon">🎲</div>
    <div class="hp-card-title">Surprise!</div>
    <p class="hp-card-desc">Let the dice decide &mdash; jump to a randomly selected case from anywhere in the Court&rsquo;s history. A great way to stumble across something you would never have searched for.</p>
  </div>

</div>

<p class="hp-footer">
  Questions or suggestions? <a href="mailto:admin@argumentaloud.org">Contact us</a>
  &nbsp;&middot;&nbsp;
  <a href="https://github.com/jeffpar/argument-aloud">GitHub</a>
</p>

<script>
document.querySelectorAll('.hp-card[data-href]').forEach(card => {
  card.addEventListener('click', e => {
    if (!e.target.closest('a')) window.location.href = card.dataset.href;
  });
});
</script>
