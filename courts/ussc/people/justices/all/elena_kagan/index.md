---
title: Justice Elena Kagan
layout: pane
justice_id: elena_kagan
years_served: 15.9
opinions: 107
lone_dissents: 1
vocal_secs: 224450
case_count: 6
first_argument: September 9, 2009
last_argument: March 31, 2010
---
<div style="display:flex; gap:1em;">
<div style="flex:2; min-width:0; overflow:hidden;">
<h1>{{ page.title }}</h1>
<p>Served from August 7, 2010 to present{% if page.years_served %} ({{ page.years_served }} years){% endif %}.</p>
{% if page.case_count %}<p>Also argued {{ page.case_count }} {% if page.case_count == 1 %}case on {{ page.last_argument }}{% else %}cases from {{ page.first_argument }} to {{ page.last_argument }}{% endif %}.</p>{% endif %}
{% if page.opinions or page.lone_dissents %}<p>Wrote {% if page.opinions %}{{ page.opinions }} majority <a href="/courts/ussc/?collection=opinions&id={{ page.justice_id }}">opinion{% if page.opinions != 1 %}s{% endif %}</a>{% endif %}{% if page.opinions and page.lone_dissents %} and {% endif %}{% if page.lone_dissents %}{{ page.lone_dissents }} lone <a href="/courts/ussc/?collection=lone_dissents&id={{ page.justice_id }}">dissent{% if page.lone_dissents != 1 %}s{% endif %}</a>{% endif %}.</p>{% endif %}
{% if page.vocal_secs %}<p>Spoke for {{ page.vocal_secs | divided_by: 3600.0 | round: 1 }} hours in oral arguments. <a href="/courts/ussc/?collection=vocal_justices&id={{ page.justice_id }}">View vocal statistics &rsaquo;</a></p>{% endif %}
</div>
<div class="jp-frame"><img src="portrait.jpg" alt="{{ page.title }}" onerror="this.parentElement.style.display='none'"></div>
</div>
