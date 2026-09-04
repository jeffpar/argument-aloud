---
title: Blog
layout: pane
styles:
- /assets/css/pages.css
---
# Argument Aloud Blog

{%- assign blog_posts = site.pages | where_exp: "p", "p.url contains '/courts/ussc/blog/'" | where_exp: "p", "p.date" | sort: "date" | reverse %}
{%- assign blog_posts = blog_posts | slice: 0, 20 %}

<div class="blog-list">
{%- for post in blog_posts %}
  {%- comment -%}
    Excerpt = the post's first paragraph that isn't a leading italic-only
    line (an "or, " tagline, the post's own date line, an "Originally
    posted on" byline, etc.) — a rendered paragraph is "italic-only" iff
    it's exactly a p tag wrapping a single em tag and nothing else. Content
    starts after the post's own h1.
  {%- endcomment -%}
  {%- assign blog_after_h1 = post.content | split: "</h1>" %}
  {%- assign blog_body = blog_after_h1[1] | default: post.content %}
  {%- assign blog_paragraphs = blog_body | split: "</p>" %}
  {%- assign blog_excerpt = "" %}
  {%- for blog_part in blog_paragraphs %}
    {%- assign blog_frag = blog_part | strip | append: "</p>" %}
    {%- assign blog_frag_text = blog_frag | strip_html | strip %}
    {%- if blog_frag_text == "" %}
      {%- continue %}
    {%- endif %}
    {%- assign blog_prefix = blog_frag | slice: 0, 7 %}
    {%- assign blog_suffix = blog_frag | slice: -9, 9 %}
    {%- if blog_prefix == "<p><em>" and blog_suffix == "</em></p>" %}
      {%- continue %}
    {%- endif %}
    {%- assign blog_excerpt = blog_frag %}
    {%- break %}
  {%- endfor %}
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
