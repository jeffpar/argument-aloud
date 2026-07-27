---
title: Blog
layout: pane
styles:
- /assets/css/pages.css
---
# Blog

{%- assign blog_posts = site.pages | where_exp: "p", "p.url contains '/courts/ussc/blog/'" | where_exp: "p", "p.date" | sort: "date" | reverse %}
{%- assign blog_posts = blog_posts | slice: 0, 20 %}

<div class="blog-list">
{%- for post in blog_posts %}
  {%- assign blog_parts = post.content | split: "</p>" %}
  {%- assign blog_excerpt = blog_parts[1] | append: "</p>" | strip %}
  {%- assign blog_url_len = post.url.size | minus: 1 %}
  {%- assign blog_path = post.url | slice: 0, blog_url_len %}
  {%- assign blog_href = "/courts/ussc/?link=" | append: blog_path %}
  <article class="blog-list-item">
    <h2 class="blog-list-title"><a href="{{ blog_href }}">{{ post.title }}</a></h2>
    <p class="blog-list-date">{{ post.date | date: "%A, %B %-d, %Y" }}</p>
    {{ blog_excerpt }}
    <p class="blog-list-more"><a href="{{ blog_href }}">Continue reading &rarr;</a></p>
  </article>
{%- endfor %}
</div>
