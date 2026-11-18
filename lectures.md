---
layout: page
title: Slides
description: Slides completas del curso, manifiestos y snippets de cada clase.
---

# Slides y ejemplos

Cada clase trae sus slides embebidas, los manifiestos que se usan en vivo y los comandos para reproducirlos en tu clúster. Haz clic en el título de una clase para abrirla en su propia página. Todos los archivos viven en la carpeta [`_includes/snippets`]({{ site.github_repo }}/tree/main/_includes/snippets) del repositorio y se pueden aplicar directo con `kubectl`.

{: .note }
Antes de empezar, levanta el clúster local siguiendo la clase 1 y crea el namespace de la clase 2. Todos los ejemplos asumen el namespace `softav`.

{% assign lectures = site.lectures | sort: "nav_order" %}
{% for lecture in lectures %}
{% include lecture-card.html lecture=lecture body=lecture.content %}
{% endfor %}
