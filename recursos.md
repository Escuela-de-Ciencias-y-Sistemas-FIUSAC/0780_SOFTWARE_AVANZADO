---
layout: page
title: Recursos
description: Recursos gratuitos para practicar Kubernetes, Spring Boot y preparar la certificación.
---

# Recursos gratuitos
{:.no_toc}

Todo lo que está en esta página se puede usar sin pagar. Donde un servicio tiene un tier gratuito con límites, se indica.

## Tabla de contenido
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Practicar en el navegador, sin instalar nada

| Recurso | Qué ofrece | Límite |
|---|---|---|
| [Killercoda](https://killercoda.com/playgrounds/scenario/kubernetes) | Clústeres de Kubernetes listos en segundos y escenarios guiados, incluidos los de preparación para CKAD y CKA | Sesiones de 1 hora, se reinician al cerrar |
| [Play with Kubernetes](https://labs.play-with-k8s.com/) | Nodos vacíos para montar el clúster con kubeadm a mano | Sesiones de 4 horas, requiere cuenta de Docker o GitHub |
| [iximiuz Labs](https://labs.iximiuz.com/) | Playgrounds de Kubernetes, containerd y Linux con retos prácticos | Tier gratuito con horas limitadas al mes |
| [Tutoriales interactivos de kubernetes.io](https://kubernetes.io/docs/tutorials/kubernetes-basics/) | Los conceptos básicos oficiales con ejercicios paso a paso | Sin límite |

## Clúster local en tu máquina

- **[kind](https://kind.sigs.k8s.io/)**. Kubernetes dentro de Docker. Es lo que usa el curso: ligero, reproducible con un YAML y soporta varios nodos. Ver la [clase 1]({{ '/clases/01-contenedores-y-spring-boot/' | relative_url }}).
- **[k3d](https://k3d.io/)**. k3s dentro de Docker. Arranca aún más rápido que kind y trae Traefik como Ingress por defecto.
- **[minikube](https://minikube.sigs.k8s.io/)**. El clásico. Más pesado, pero sus addons de `ingress`, `metrics-server` y `dashboard` se activan con un comando.
- **[Rancher Desktop](https://rancherdesktop.io/)**. Alternativa gratuita a Docker Desktop con Kubernetes incluido, útil si la licencia de Docker Desktop es un problema.
- **Docker Desktop**. Trae un Kubernetes de un nodo en Settings. Suficiente para empezar, insuficiente para ver scheduling entre nodos.

{: .tip }
En Windows todo esto corre sobre WSL2. Instala kubectl y kind dentro de la distribución Ubuntu, no en PowerShell, y evitarás la mitad de los problemas de red.

## Cursos y libros gratuitos

- **[Introduction to Kubernetes (LFS158)](https://training.linuxfoundation.org/training/introduction-to-kubernetes/)**. Curso oficial de la Linux Foundation en edX. Es la base teórica del KCNA y se puede auditar gratis.
- **[Kubernetes Patterns](https://developers.redhat.com/e-books/kubernetes-patterns)**. Ibryam y Huß, O'Reilly. Red Hat regala el PDF a cambio de un correo. Es el libro de la [clase 5]({{ '/clases/05-patrones-de-kubernetes/' | relative_url }}).
- **[Documentación oficial de Kubernetes](https://kubernetes.io/docs/home/)**. Las secciones de Concepts y Tasks son las únicas páginas permitidas durante el examen, así que aprende a navegarlas.
- **[kubectl cheat sheet](https://kubernetes.io/docs/reference/kubectl/quick-reference/)**. La hoja de referencia oficial. Imprímela.
- **[Kubernetes the Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way)**. Montar un clúster componente por componente, sin herramientas. No es para el examen, es para entender qué hay debajo.
- **[Microsoft Learn: Kubernetes](https://learn.microsoft.com/training/paths/intro-to-kubernetes-on-azure/)**. Rutas de aprendizaje gratuitas con sandbox incluido en algunos módulos.

## Preparación para la certificación

- **[Temario oficial de CKAD](https://github.com/cncf/curriculum)**. El repositorio de la CNCF publica el PDF con los dominios y su peso en el examen. Léelo antes que cualquier curso.
- **[CKAD Exercises](https://github.com/dgkanatsios/CKAD-exercises)**. Cientos de ejercicios por dominio del examen con soluciones. Es el repositorio más usado para practicar.
- **[Escenarios CKAD en Killercoda](https://killercoda.com/killer-shell-ckad)**. Los mismos autores del simulador oficial publican escenarios gratuitos por tema.
- **[killer.sh](https://killer.sh/)**. El simulador oficial. No es gratis por sí solo, pero al comprar el examen CKAD vienen incluidas dos sesiones de 36 horas. Úsalas la última semana.
- **Descuentos**. La Linux Foundation publica cupones en Black Friday y Cyber Monday, y la CNCF ofrece becas de certificación para estudiantes. Pregunta en el curso antes de pagar precio completo.

## Spring Boot en Kubernetes

- **[Guía oficial: Spring Boot Kubernetes](https://spring.io/guides/gs/spring-boot-kubernetes/)**. Del JAR al Deployment en 15 minutos.
- **[Actuator: Kubernetes probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)**. Cómo funcionan `liveness` y `readiness` en Actuator y cómo engancharles tus propios checks.
- **[Container images con Spring Boot](https://docs.spring.io/spring-boot/reference/packaging/container-images/index.html)**. Dockerfiles en capas y Buildpacks, la base del Dockerfile de la [clase 1]({{ '/clases/01-contenedores-y-spring-boot/' | relative_url }}).
- **[Spring Cloud Kubernetes](https://spring.io/projects/spring-cloud-kubernetes)**. Para cuando quieras que Spring lea ConfigMaps directamente y haga discovery de Services.

## Herramientas que hacen la vida más fácil

- **[k9s](https://k9scli.io/)**. Interfaz de terminal para navegar el clúster. Ver logs, describir y borrar con una tecla.
- **[kubectx y kubens](https://github.com/ahmetb/kubectx)**. Cambiar de clúster y de namespace sin escribir `--namespace` cada vez.
- **[stern](https://github.com/stern/stern)**. Logs de varios Pods a la vez, con colores y filtro por regex.
- **[Headlamp](https://headlamp.dev/)**. Dashboard web de la CNCF, gratuito y de código abierto.
- **[kubeconform](https://github.com/yannh/kubeconform)** y **[kube-linter](https://github.com/stackrox/kube-linter)**. Validan tus manifiestos antes de aplicarlos. Ideales para un paso de CI.
- **[Helm](https://helm.sh/)**. El gestor de paquetes. Lo verás para instalar ingress-nginx, Prometheus y Grafana.

## Nube con crédito gratuito

| Proveedor | Qué incluye | Cuidado con |
|---|---|---|
| [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) | 4 OCPU ARM y 24 GB de RAM permanentes, suficientes para un clúster k3s de tres nodos | La disponibilidad de instancias ARM varía por región |
| [GitHub Student Developer Pack](https://education.github.com/pack) | Créditos de DigitalOcean, Azure y otros al verificar tu correo de la USAC | Los créditos tienen fecha de vencimiento |
| [Google Cloud](https://cloud.google.com/free) | Crédito inicial de prueba y un tier gratuito de GKE que cubre la cuota de administración de un clúster | Los nodos sí se cobran; apaga el clúster al terminar |
| [Azure for Students](https://azure.microsoft.com/free/students/) | Crédito anual sin tarjeta de crédito para cuentas verificadas de estudiante | AKS cobra los nodos |

{: .warning }
AWS no tiene tier gratuito para EKS: el plano de control se cobra por hora desde el primer minuto. Si quieres practicar en AWS, usa k3s sobre una instancia del free tier.

## Para el repositorio del curso

Los manifiestos de todas las clases se pueden aplicar directo desde GitHub:

```bash
kubectl apply -f {{ site.snippets_raw_url }}/namespace.yaml
kubectl apply -f {{ site.snippets_raw_url }}/configmap.yaml
kubectl apply -f {{ site.snippets_raw_url }}/deployment.yaml
kubectl apply -f {{ site.snippets_raw_url }}/service.yaml
```

La lista completa está en la página de [Slides]({{ '/lectures/' | relative_url }}), dentro de cada clase.
