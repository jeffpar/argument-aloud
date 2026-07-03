---
title: Justice John Mckinley
layout: pane
justice_id: john_mckinley
wikipedia_url: https://en.wikipedia.org/wiki/John_McKinley
years_served: 15.2
days_served: "5,568"
opinions: 19
lone_dissents: 2
---
<div style="display:flex; gap:1em;">
<div style="flex:2; min-width:0; overflow:hidden;">
<h1>{{ page.title }}</h1>
<p>Served from April 22, 1837 to July 19, 1852{% if page.years_served %}{% assign yr_str = page.years_served | append: "" | remove: ".0" %} ({{ yr_str }} year{% unless yr_str == "1" %}s{% endunless %} or {{ page.days_served }} days){% elsif page.date_start %} <span id="jp-dur"></span>{% endif %}.</p>
{% if page.date_start %}<script>(function(){var e=document.getElementById("jp-dur");if(!e)return;var ms=Date.now()-Date.parse("{{ page.date_start }}")+86400000;var d=Math.floor(ms/86400000);var y=(ms/(365.25*86400000)).toFixed(1).replace(/\.0$/,"");e.textContent="("+y+" year"+(y==="1"?"":"s")+" or "+d.toLocaleString()+" days)";}());</script>{% endif %}
{% if page.case_count %}<p>Also argued {{ page.case_count }} {% if page.case_count == 1 %}<a href="/courts/ussc/?collection=justice_advocates&id={{ page.justice_id }}">case</a> on {{ page.last_argument }}{% else %}<a href="/courts/ussc/?collection=justice_advocates&id={{ page.justice_id }}">cases</a> from {{ page.first_argument }} to {{ page.last_argument }}{% endif %}.</p>{% endif %}
{% if page.opinions or page.lone_dissents or page.vocal_secs %}<p>{% if page.opinions or page.lone_dissents %}Wrote {% if page.opinions %}{{ page.opinions }} majority <a href="/courts/ussc/?collection=opinions&id={{ page.justice_id }}">opinion{% if page.opinions != 1 %}s{% endif %}</a>{% endif %}{% if page.opinions and page.lone_dissents %} and {% endif %}{% if page.lone_dissents %}{{ page.lone_dissents }} lone <a href="/courts/ussc/?collection=lone_dissents&id={{ page.justice_id }}">dissent{% if page.lone_dissents != 1 %}s{% endif %}</a>{% endif %}{% if page.vocal_secs %}, and spoke for {{ page.vocal_secs | divided_by: 3600.0 | round: 1 }} hours in <a href="/courts/ussc/?collection=vocal_justices&id={{ page.justice_id }}">oral arguments</a>{% endif %}{% elsif page.vocal_secs %}Spoke for {{ page.vocal_secs | divided_by: 3600.0 | round: 1 }} hours in <a href="/courts/ussc/?collection=vocal_justices&id={{ page.justice_id }}">oral arguments</a>{% endif %}.</p>{% endif %}
<p>Note: All service calculations are inclusive, meaning they include the first and last days of service, as well as all days between.</p>
</div>
<div class="jp-frame"><img src="portrait.jpg" alt="{{ page.title }}" onerror="this.parentElement.style.display='none'"></div>
</div>
