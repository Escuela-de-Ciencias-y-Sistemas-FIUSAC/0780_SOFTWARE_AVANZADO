---
layout: page
title: Consola
description: Simulador de kubectl, kind y docker en el navegador, con los manifiestos del curso ya cargados.
---

# Consola
{:.no_toc}

Practica los comandos del curso sin instalar nada. La consola trae los mismos manifiestos que usamos en clase (`ls` para verlos, `cat deployment.yaml` para leerlos) y responde como lo haría un clúster de kind: los Pods pasan por `ContainerCreating`, fallan con `ImagePullBackOff` si no cargaste la imagen, y un Service sin endpoints devuelve 503 detrás del Ingress.

{: .tip }
Empieza con `tutorial` para ver el flujo completo de las clases 1 a 5, o pulsa **crear clúster** y sigue con `kubectl apply -f namespace.yaml`. Cada comando que ejecutas avanza el reloj del clúster, así que si un Pod sigue en `ContainerCreating` repite el `kubectl get pods`.

{% include console.html autofocus=true %}

## Qué puedes hacer aquí

- **Flujo de la clase 1**: `docker build`, `docker run`, `curl localhost:8080/actuator/health`, `kind create cluster`, `kind load docker-image`.
- **kubectl de todos los días**: `get`, `describe`, `apply -f`, `create`, `run`, `expose`, `delete`, `scale`, `set image`, `rollout`, `logs`, `exec -- env`, `patch`, `port-forward`, `top` y `explain`, con `-n`, `-A`, `-o wide|yaml`, `-l` y `--show-labels`.
- **Hábitos del examen CKAD**: `alias k=kubectl`, `export do="--dry-run=client -o yaml"` y luego `k create deployment demo --image=nginx $do` para generar YAML sin tocar el clúster.
- **Tuberías**: `kubectl get pods -A | grep -v Running`, `| wc -l`, `| head`, y encadenar con `&&`.
- **Editar manifiestos**: no hay editor, pero `sed -i 's/viejo/nuevo/' archivo.yaml` modifica la copia en memoria y después `kubectl apply -f archivo.yaml` la aplica.

## Reto: break-fix

`kubectl apply -f break-fix-01.yaml` despliega una aplicación con varios errores intencionales. Diagnostica con `kubectl get pods -l app=catalogo-bf`, `kubectl describe pod` y `kubectl logs`, corrige el YAML con `sed -i`, vuelve a aplicar y repite hasta que `kubectl get endpoints catalogo-bf` muestre dos direcciones. Cada error que arregles destapa el siguiente, igual que en un clúster real.

## Lo que el simulador no hace

- No ejecuta contenedores ni código: las respuestas de la app `catalogo` son fijas.
- `--watch` y `logs -f` no bloquean; vuelve a ejecutar el comando.
- No descarga manifiestos de internet, salvo los dos que usa el curso: ingress-nginx y metrics-server.
- No tiene `kubectl edit`, `helm` ni shell interactiva dentro de los Pods.

## Cuando quieras un clúster real

Para practicar con Kubernetes de verdad sin instalar nada, usa los playgrounds listados en [Recursos]({{ '/recursos/#practicar-en-el-navegador-sin-instalar-nada' | relative_url }}). Para instalar kind en tu máquina, sigue la [clase 1]({{ '/clases/01-contenedores-y-spring-boot/' | relative_url }}).
