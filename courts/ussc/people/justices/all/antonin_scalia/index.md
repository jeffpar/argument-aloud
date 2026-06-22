---
title: Justice Antonin Scalia
layout: pane
case_count: 1
first_argument: January 19, 1976
last_argument: January 19, 1976
---
<div style="display:flex; gap:1em;">
<div style="flex:2; min-width:0; overflow:hidden;">
<h1>{{ page.title }}</h1>
<p>Served from September 26, 1986 to February 13, 2016.</p>
{% if page.case_count %}<p>Also argued {{ page.case_count }} {% if page.case_count == 1 %}case on {{ page.last_argument }}{% else %}cases from {{ page.first_argument }} to {{ page.last_argument }}{% endif %}.</p>{% endif %}
</div>
<img src="portrait.jpg" alt="{{ page.title }}" style="flex:1; min-width:0; width:100%; height:auto; display:block; align-self:flex-start;" onerror="this.style.display='none'">
</div>
