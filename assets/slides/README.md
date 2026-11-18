# Slides del curso

Cada clase vive en `_lectures/NN-nombre.md`. Para que sus slides aparezcan embebidas en la página de la clase y en la página **Slides**, agrega el campo `slides` en el front matter (el bloque entre `---` al inicio del archivo). No hace falta tocar el cuerpo del markdown: la plantilla `_includes/lecture-card.html` dibuja el visor, el botón "Abrir slides" y, para PDF, el botón "Descargar PDF".

## Opción 1: PDF en este repositorio

1. Exporta la presentación a PDF y guárdala aquí con el mismo nombre que el archivo de la clase, por ejemplo `01-contenedores-y-spring-boot.pdf`. Sin espacios ni acentos: los espacios rompen la URL.
2. En `_lectures/01-contenedores-y-spring-boot.md`:

```yaml
---
title: "Clase 1: Contenedores y Spring Boot"
nav_order: 1
slides: /assets/slides/01-contenedores-y-spring-boot.pdf
---
```

Mantén cada PDF por debajo de 25 MB (GitHub Pages no sirve Git LFS). Si pesa más, comprímelo o súbelo a Google Drive y usa la opción 3.

## Opción 2: Google Slides

En Google Slides: Archivo, Compartir, Publicar en la web, pestaña Insertar. Copia solo la URL del atributo `src` del iframe y pégala en `slides`:

```yaml
slides: https://docs.google.com/presentation/d/e/2PACX-XXXX/pubembed?start=false&loop=false&delayms=3000
```

Cualquier URL con `://` se embebe tal cual, así que también sirven Canva (Compartir, Insertar), Pitch o un reveal.js publicado.

## Opción 3: PDF en Google Drive

Comparte el archivo como "Cualquier persona con el enlace" y usa la URL de vista previa:

```yaml
slides: https://drive.google.com/file/d/ID_DEL_ARCHIVO/preview
```

## Notas

- Si una clase no tiene `slides`, la página muestra un aviso de "pendiente" en lugar del visor.
- Este README está excluido del sitio en `_config.yml` para que no aparezca como página en el menú.
