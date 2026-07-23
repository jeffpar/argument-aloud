---
title: "Blog"
layout: pane
---

<style>
.blog-list-item {
  padding-bottom: 1.1rem;
  margin-bottom: 1.1rem;
  border-bottom: 1px solid #e0e0e0;
}
.blog-list-item:last-child { border-bottom: none; }
@media (prefers-color-scheme: dark) { .blog-list-item { border-color: #2d2f38; } }
html[data-theme="dark"]  .blog-list-item { border-color: #2d2f38; }
html[data-theme="light"] .blog-list-item { border-color: #e0e0e0; }
.blog-list-title { margin: 0 0 2px; }
.blog-list-title a { text-decoration: none; }
.blog-list-title a:hover { text-decoration: underline; }
.blog-list-date { font-size: 0.78rem; opacity: 0.6; margin: 0 0 0.6rem; }
.blog-list-more { margin-top: 0.4rem; }
</style>

# Blog

{%- assign blog_posts = site.pages | where_exp: "p", "p.url contains '/courts/ussc/blog/'" | where_exp: "p", "p.date" | sort: "date" | reverse %}
{%- assign blog_posts = blog_posts | slice: 0, 20 | reverse %}

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
