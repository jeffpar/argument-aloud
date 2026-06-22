---
title: Justice Ruth Bader Ginsburg
layout: pane
case_count: 6
first_argument: January 17, 1973
last_argument: November 1, 1978
---
<div style="display:flex; gap:1em;">
<div style="flex:2; min-width:0; overflow:hidden;">
<h1>{{ page.title }}</h1>
<p>Served from August 10, 1993 to September 18, 2020.</p>
{% if page.case_count %}<p>Also argued {{ page.case_count }} {% if page.case_count == 1 %}case on {{ page.last_argument }}{% else %}cases from {{ page.first_argument }} to {{ page.last_argument }}{% endif %}.</p>{% endif %}
</div>
<img src="portrait.jpg" alt="{{ page.title }}" style="flex:1; min-width:0; width:100%; height:auto; display:block; align-self:flex-start;" onerror="this.style.display='none'">
</div>
