---
title: Justice Charles Whittaker
layout: pane
justice_id: charles_whittaker
years_served: 5.0
opinions: 42
lone_dissents: 12
vocal_secs: 61817
---
<div style="display:flex; gap:1em;">
<div style="flex:2; min-width:0; overflow:hidden;">
<h1>{{ page.title }}</h1>
<p>Served from March 25, 1957 to March 31, 1962{% if page.years_served %} ({{ page.years_served }} years){% endif %}.</p>
{% if page.case_count %}<p>Also argued {{ page.case_count }} {% if page.case_count == 1 %}case on {{ page.last_argument }}{% else %}cases from {{ page.first_argument }} to {{ page.last_argument }}{% endif %}.</p>{% endif %}
{% if page.opinions or page.lone_dissents %}<p>Wrote {% if page.opinions %}{{ page.opinions }} majority <a href="/courts/ussc/?collection=opinions&id={{ page.justice_id }}">opinion{% if page.opinions != 1 %}s{% endif %}</a>{% endif %}{% if page.opinions and page.lone_dissents %} and {% endif %}{% if page.lone_dissents %}{{ page.lone_dissents }} lone <a href="/courts/ussc/?collection=lone_dissents&id={{ page.justice_id }}">dissent{% if page.lone_dissents != 1 %}s{% endif %}</a>{% endif %}.</p>{% endif %}
{% if page.vocal_secs %}<p>Spoke for {{ page.vocal_secs | divided_by: 3600.0 | round: 1 }} hours in oral arguments. <a href="/courts/ussc/?collection=vocal_justices&id={{ page.justice_id }}">View vocal statistics &rsaquo;</a></p>{% endif %}
</div>
<img src="portrait.jpg" alt="{{ page.title }}" style="flex:1; min-width:0; width:100%; height:auto; display:block; align-self:flex-start;" onerror="this.style.display='none'">
</div>
