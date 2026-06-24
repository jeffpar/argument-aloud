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
  opacity: 0.55;
  margin: 0;
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
  opacity: 0.72;
  flex: 1;
  margin: 0;
}
.hp-footer {
  text-align: center;
  font-size: 0.77rem;
  opacity: 0.45;
  padding-bottom: 16px;
}
@media (prefers-color-scheme: dark) {
  .hp-card           { background: #1e2130; border-color: #2d2f38; }
  .hp-card:hover     { border-color: #454a5a; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
  .hp-card-title     { color: #5eaee0; }
}
html[data-theme="dark"]  .hp-card           { background: #1e2130; border-color: #2d2f38; }
html[data-theme="dark"]  .hp-card:hover     { border-color: #454a5a; box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
html[data-theme="dark"]  .hp-card-title     { color: #5eaee0; }
html[data-theme="light"] .hp-card           { background: #fff; border-color: #e0e4ea; }
html[data-theme="light"] .hp-card:hover     { border-color: #b8c4d8; }
html[data-theme="light"] .hp-card-title     { color: #2672b4; }
</style>

<div class="hp-hero">
  <h1>Argument Aloud</h1>
  <p class="hp-tagline">A media hub that connects (almost) every U.S. Supreme Court argument with all available files (briefs, transcripts, recordings, opinions) &mdash; all in one place.</p>
  <p class="hp-example">See it in action: <a href="/courts/ussc/?term=2025-10&case=24-1260&turn=369">Watson v. RNC (No.&nbsp;24-1260)</a></p>
</div>

<div class="hp-grid">

  <a class="hp-card" href="/courts/ussc/?term=1791-08&case=1791-001&file=usrep002401.pdf">
    <div class="hp-icon">⚖️</div>
    <div class="hp-card-title">Cases</div>
    <p class="hp-card-desc">Browse cases from the earliest argued case in 1791 to the present. Where available, cases include all supporting materials, and of course, the Court's final decision.</p>
  </a>

  <a class="hp-card" href="/courts/ussc/?collection=gallery">
    <div class="hp-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:1.6rem;height:1.6rem" fill="#c8955c"><rect height="20" transform="matrix(0.7075 -0.7067 0.7067 0.7075 -5.6854 13.7194)" width="4" x="11.73" y="3.73"/><rect height="8" transform="matrix(0.707 -0.7072 0.7072 0.707 0.3157 11.246)" width="4" x="11.73" y="1.24"/><rect height="8" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -8.1722 7.7256)" width="4" x="3.24" y="9.73"/></svg></div>
    <div class="hp-card-title">Justices</div>
    <p class="hp-card-desc">Visit a gallery of statistics, including years of service and time speaking in oral arguments, as well as all the opinions &mdash; and lonely dissents &mdash; written.</p>
  </a>

  <a class="hp-card" href="/courts/ussc/?collection=top_advocates&id=edwin_s_kneedler">
    <div class="hp-icon">🎙️</div>
    <div class="hp-card-title">Advocates</div>
    <p class="hp-card-desc">Survey the men <em>and</em> women who have argued cases &mdash; by name, frequency, or gender. Some have even received special recognition for their service.</p>
  </a>

  <a class="hp-card" href="/courts/ussc/?term=2025-10&case=24-109">
    <div class="hp-icon">✏️</div>
    <div class="hp-card-title">Transcripts</div>
    <p class="hp-card-desc">Spot an error? Correct speaker labels or transcript text directly in the browser, then download your edits for submission (see the Transcripts menu at top right).</p>
  </a>

  <a class="hp-card" href="/courts/ussc/?collection=briefs&group=1">
    <div class="hp-icon">📚</div>
    <div class="hp-card-title">Collections</div>
    <p class="hp-card-desc">Stroll through collections of historical briefs and transcripts. Sift through old Original Jurisdicion cases. Or explore third-party collections, like the Supreme Court's Greatest Hits.</p>
  </a>

  <a class="hp-card" href="/courts/ussc?collection=noteworthy">
    <div class="hp-icon">🗂️</div>
    <div class="hp-card-title">Topics</div>
    <p class="hp-card-desc">Cases can also browsed by topic, such as Segregation or the Death Penalty (with more to come), or by constitutional amendment, statute, or other legal provision.</p>
  </a>

  <a class="hp-card" href='/courts/ussc/?term=all&find="broccoli"+scalia'>
    <div class="hp-icon">🔍</div>
    <div class="hp-card-title">Searches</div>
    <p class="hp-card-desc">Search across case titles, speaker names, or transcripts. Better yet, find that reference to "broccoli" by Justice Scalia you've heard so much about.</p>
  </a>

  <a class="hp-card" href="/courts/ussc">
    <div class="hp-icon">🔗</div>
    <div class="hp-card-title">Links</div>
    <p class="hp-card-desc">As you're reading and listening to a transcript, notice that every speaker is a link, and every date is a window onto what else happened on the same day.</p>
  </a>

  <a class="hp-card" href="/courts/ussc">
    <div class="hp-icon">🔖</div>
    <div class="hp-card-title">Tags</div>
    <p class="hp-card-desc">Mark cases as favorites or apply your own tags. Export your selections at any time for safekeeping or to share. Nothing is stored remotely, everything is saved in your browser.</p>
  </a>

  <a class="hp-card" href="/courts/ussc">
    <div class="hp-icon">🏛️</div>
    <div class="hp-card-title">Sources</div>
    <p class="hp-card-desc">Only trusted sources of data are used, starting with The U.S. Supreme Court, The National Archives, The Oyez Project, and other scholarly work.</p>
  </a>

  <a class="hp-card" href="https://github.com/jeffpar/argument-aloud">
    <div class="hp-icon">🐙</div>
    <div class="hp-card-title">Repositories</div>
    <p class="hp-card-desc">This site is built from open-source repositories stored on GitHub.  Anyone is welcome to collaborate, but if you're feeling reclusive, fork it and do your own thing.</p>
  </a>

  <a class="hp-card" href="/courts/ussc/?action=randomize&start=1955-10">
    <div class="hp-icon">🎲</div>
    <div class="hp-card-title">Surprise!</div>
    <p class="hp-card-desc">Let the dice decide &mdash; jump to a randomly selected case from anywhere in the Court&rsquo;s history. A great way to stumble across something you would never have searched for.</p>
  </a>

</div>

<p class="hp-footer">
  Questions or suggestions? <a href="mailto:admin@argumentaloud.org">Contact us</a>
  &nbsp;&middot;&nbsp;
  <a href="https://github.com/jeffpar/argument-aloud">GitHub</a>
</p>
