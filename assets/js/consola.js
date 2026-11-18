/*
 * Consola del curso: un simulador de kubectl / kind / docker que corre en el navegador.
 * No hay un clúster real detrás. El estado vive en memoria y se pierde al recargar.
 *
 * El archivo tiene dos partes:
 *   1. createSim(files)  -> motor puro (sin DOM) que recibe líneas y devuelve texto. Se prueba con Node.
 *   2. UI con xterm.js   -> solo corre en el navegador si existe #consola.
 */
(function (global) {
  'use strict';

  var yaml = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('js-yaml')
    : global.jsyaml;

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  var KINDS = {
    pod:                     { aliases: ['po', 'pod', 'pods'], api: 'v1', Kind: 'Pod', ns: true, res: 'pod' },
    deployment:              { aliases: ['deploy', 'deployment', 'deployments'], api: 'apps/v1', Kind: 'Deployment', ns: true, res: 'deployment.apps' },
    replicaset:              { aliases: ['rs', 'replicaset', 'replicasets'], api: 'apps/v1', Kind: 'ReplicaSet', ns: true, res: 'replicaset.apps' },
    service:                 { aliases: ['svc', 'service', 'services'], api: 'v1', Kind: 'Service', ns: true, res: 'service' },
    configmap:               { aliases: ['cm', 'configmap', 'configmaps'], api: 'v1', Kind: 'ConfigMap', ns: true, res: 'configmap' },
    secret:                  { aliases: ['secret', 'secrets'], api: 'v1', Kind: 'Secret', ns: true, res: 'secret' },
    ingress:                 { aliases: ['ing', 'ingress', 'ingresses'], api: 'networking.k8s.io/v1', Kind: 'Ingress', ns: true, res: 'ingress.networking.k8s.io' },
    horizontalpodautoscaler: { aliases: ['hpa', 'horizontalpodautoscaler', 'horizontalpodautoscalers'], api: 'autoscaling/v2', Kind: 'HorizontalPodAutoscaler', ns: true, res: 'horizontalpodautoscaler.autoscaling' },
    resourcequota:           { aliases: ['quota', 'resourcequota', 'resourcequotas'], api: 'v1', Kind: 'ResourceQuota', ns: true, res: 'resourcequota' },
    limitrange:              { aliases: ['limits', 'limitrange', 'limitranges'], api: 'v1', Kind: 'LimitRange', ns: true, res: 'limitrange' },
    endpoints:               { aliases: ['ep', 'endpoints', 'endpointslice', 'endpointslices'], api: 'v1', Kind: 'Endpoints', ns: true, res: 'endpoints', derived: true },
    namespace:               { aliases: ['ns', 'namespace', 'namespaces'], api: 'v1', Kind: 'Namespace', ns: false, res: 'namespace' },
    node:                    { aliases: ['no', 'node', 'nodes'], api: 'v1', Kind: 'Node', ns: false, res: 'node', derived: true }
  };

  function kindOf(word) {
    if (!word) return null;
    var w = String(word).toLowerCase();
    for (var k in KINDS) {
      if (k === w || KINDS[k].Kind.toLowerCase() === w || KINDS[k].aliases.indexOf(w) >= 0) return k;
    }
    return null;
  }

  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  function table(rows) {
    if (!rows.length) return [];
    var widths = [];
    rows.forEach(function (r) { r.forEach(function (c, i) { widths[i] = Math.max(widths[i] || 0, String(c).length); }); });
    return rows.map(function (r) {
      return r.map(function (c, i) { return i === r.length - 1 ? String(c) : pad(c, widths[i] + 3); }).join('').replace(/\s+$/, '');
    });
  }

  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }
  var HASH_ALPHABET = 'bcdfghjklmnpqrstvwxz2456789';
  function hashName(str, len) {
    var h = hash(str), out = '';
    for (var i = 0; i < len; i++) { out += HASH_ALPHABET[h % HASH_ALPHABET.length]; h = Math.floor(h / HASH_ALPHABET.length) + i * 7919; }
    return out;
  }
  var seq = 0;
  function randName(len) { seq++; return hashName('r' + seq + Date.now(), len); }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
  function deepMerge(target, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    if (target === null || typeof target !== 'object' || Array.isArray(target)) target = {};
    Object.keys(patch).forEach(function (k) {
      if (patch[k] === null) delete target[k];
      else target[k] = deepMerge(target[k], patch[k]);
    });
    return target;
  }

  function parseMem(v) {
    if (v == null) return null;
    var m = String(v).match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G|m)?$/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    var unit = m[2] || '';
    var mult = { '': 1, Ki: 1024, Mi: 1024 * 1024, Gi: 1024 * 1024 * 1024, K: 1e3, M: 1e6, G: 1e9, m: 1e-3 }[unit];
    return n * mult;
  }
  function parseCpu(v) {
    if (v == null) return null;
    var s = String(v);
    if (/m$/.test(s)) return parseInt(s, 10);
    return parseFloat(s) * 1000;
  }

  function ageOf(ticks) {
    var s = ticks * 7; // cada comando "dura" unos segundos
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? (s % 60) + 's' : '');
    return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
  }

  // Tokenizador estilo shell: respeta comillas simples y dobles, separa | && ;
  function tokenize(line) {
    var tokens = [], cur = '', quote = null, has = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quote) {
        if (ch === quote) { quote = null; }
        else if (ch === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; }
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
      if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
      if (/\s/.test(ch)) { if (has || cur) { tokens.push(cur); cur = ''; has = false; } continue; }
      if (ch === '|' || ch === ';' || (ch === '&' && line[i + 1] === '&')) {
        if (has || cur) { tokens.push(cur); cur = ''; has = false; }
        if (ch === '&') { tokens.push('&&'); i++; } else tokens.push(ch);
        continue;
      }
      if (ch === '#') break;
      cur += ch; has = true;
    }
    if (quote) return { error: 'error de sintaxis: falta cerrar una comilla (' + quote + ')' };
    if (has || cur) tokens.push(cur);
    return { tokens: tokens };
  }

  // ---------------------------------------------------------------------------
  // Motor
  // ---------------------------------------------------------------------------
  function createSim(files) {
    files = Object.assign({}, files || {});
    var S;

    function reset() {
      S = {
        tick: 0,
        cluster: null,            // { name, nodes: [{name, role}] }
        images: {},               // imágenes construidas/pulled en la máquina local
        loaded: {},               // imágenes cargadas al clúster con kind load
        ns: 'default',
        objs: {},                 // kind -> { key -> obj }
        aliases: {},
        env: {},
        installed: {},            // ingress-nginx, metrics-server
        dockerRun: null,
        portForward: null,
        history: []
      };
      for (var k in KINDS) S.objs[k] = {};
    }
    reset();

    // ----- almacenamiento -----
    function key(kind, ns, name) { return KINDS[kind].ns ? (ns + '/' + name) : name; }
    function get(kind, ns, name) { return S.objs[kind][key(kind, ns, name)] || null; }
    function list(kind, ns) {
      var out = [];
      for (var k in S.objs[kind]) {
        var o = S.objs[kind][k];
        if (ns === '*' || !KINDS[kind].ns || o.metadata.namespace === ns) out.push(o);
      }
      out.sort(function (a, b) { return a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0; });
      return out;
    }
    function put(kind, obj) { S.objs[kind][key(kind, obj.metadata.namespace, obj.metadata.name)] = obj; return obj; }
    function del(kind, ns, name) { delete S.objs[kind][key(kind, ns, name)]; }

    function nsExists(ns) { return !!S.objs.namespace[ns]; }

    function newObj(kind, name, ns, spec, extra) {
      var o = { apiVersion: KINDS[kind].api, kind: KINDS[kind].Kind, metadata: { name: name, labels: {} } };
      if (KINDS[kind].ns) o.metadata.namespace = ns;
      if (spec) o.spec = spec;
      Object.assign(o, extra || {});
      o._sim = { created: S.tick };
      return o;
    }

    function bootstrapCluster(name, nodes) {
      S.cluster = { name: name, nodes: nodes };
      S.loaded = {};
      for (var k in KINDS) S.objs[k] = {};
      S.installed = {};
      ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage'].forEach(function (n) {
        put('namespace', newObj('namespace', n));
      });
      put('service', newObj('service', 'kubernetes', 'default', { type: 'ClusterIP', clusterIP: '10.96.0.1', ports: [{ port: 443, targetPort: 6443, protocol: 'TCP', name: 'https' }] }));
      S.ns = 'default';
    }

    // ----- imágenes -----
    var PUBLIC_IMAGES = /^(docker\.io\/)?(library\/)?(busybox|nginx|redis|postgres|alpine|httpd|ubuntu|debian|eclipse-temurin|hashicorp\/http-echo|traefik|mysql|mongo|memcached)(:|@|$)|^(registry\.k8s\.io|gcr\.io|ghcr\.io|quay\.io)\//;
    function imageAvailable(img) {
      if (!img) return false;
      if (PUBLIC_IMAGES.test(img)) return true;
      return !!S.loaded[img];
    }

    // ----- Deployments -> ReplicaSets -> Pods -----
    function reconcile() {
      // deployments
      list('deployment', '*').forEach(function (d) {
        var ns = d.metadata.namespace;
        var replicas = d.spec.replicas == null ? 1 : d.spec.replicas;
        var tmpl = d.spec.template || { metadata: { labels: {} }, spec: { containers: [] } };
        var h = hashName(JSON.stringify(tmpl), 9);
        var rsName = d.metadata.name + '-' + h;
        var rs = get('replicaset', ns, rsName);
        if (!rs) {
          rs = newObj('replicaset', rsName, ns, { replicas: replicas, selector: d.spec.selector, template: deepClone(tmpl) });
          rs.metadata.labels = Object.assign({}, tmpl.metadata && tmpl.metadata.labels, { 'pod-template-hash': h });
          rs._sim.owner = d.metadata.name;
          rs._sim.revision = (d._sim.revision = (d._sim.revision || 0) + 1);
          put('replicaset', rs);
        }
        rs.spec.replicas = replicas;
        // los RS viejos del mismo deployment se escalan a 0
        list('replicaset', ns).forEach(function (old) {
          if (old._sim.owner === d.metadata.name && old.metadata.name !== rsName) old.spec.replicas = 0;
        });
      });
      // replicasets -> pods
      list('replicaset', '*').forEach(function (rs) {
        var ns = rs.metadata.namespace;
        var want = rs.spec.replicas == null ? 1 : rs.spec.replicas;
        var pods = list('pod', ns).filter(function (p) { return p._sim.owner === rs.metadata.name; });
        while (pods.length > want) { var victim = pods.pop(); del('pod', ns, victim.metadata.name); }
        while (pods.length < want) {
          var p = newObj('pod', rs.metadata.name + '-' + randName(5), ns, deepClone(rs.spec.template.spec));
          p.metadata.labels = Object.assign({}, rs.spec.template.metadata && rs.spec.template.metadata.labels, { 'pod-template-hash': rs.metadata.labels['pod-template-hash'] });
          p._sim.owner = rs.metadata.name;
          placePod(p);
          put('pod', p);
          pods.push(p);
        }
      });
      // pods huérfanos (sin spec) no deberían existir
    }

    function placePod(p) {
      var nodes = S.cluster ? S.cluster.nodes : [];
      var workers = nodes.filter(function (n) { return n.role === 'worker'; });
      var pool = workers.length ? workers : nodes;
      var idx = pool.length ? hash(p.metadata.name) % pool.length : 0;
      p._sim.node = pool.length ? pool[idx].name : '<none>';
      p._sim.ip = '10.244.' + (idx + 1) + '.' + (10 + (hash(p.metadata.name + 'ip') % 200));
    }

    // Estado simulado de un Pod a partir de su spec y del tiempo transcurrido.
    function podView(p) {
      var age = S.tick - p._sim.created;
      var spec = p.spec || {};
      var cs = spec.containers || [];
      var ics = spec.initContainers || [];
      var total = cs.length || 1;
      var v = { ready: 0, total: total, status: 'Running', restarts: 0, age: age, events: [], problems: [] };
      var ns = p.metadata.namespace;

      // 1) init containers
      for (var i = 0; i < ics.length; i++) {
        var ic = ics[i];
        if (!imageAvailable(ic.image)) { v.status = age < 1 ? 'Init:ErrImagePull' : 'Init:ImagePullBackOff'; v.events.push('Failed to pull image "' + ic.image + '": not found'); return v; }
        var cmd = (ic.command || []).join(' ') + ' ' + (ic.args || []).join(' ');
        var m = cmd.match(/nc -z (\S+) (\d+)/);
        if (m) {
          var dep = get('service', ns, m[1]);
          var depReady = dep && serviceEndpoints(dep).length > 0;
          if (!depReady) { v.status = 'Init:' + i + '/' + ics.length; v.events.push('Init container "' + ic.name + '" is waiting for ' + m[1] + ':' + m[2]); v.problems.push('init-wait:' + m[1]); return v; }
        }
        if (age < i + 1) { v.status = 'Init:' + i + '/' + ics.length; return v; }
      }
      var base = ics.length; // los init consumen ticks
      if (ics.length && age < base + 1) { v.status = 'PodInitializing'; return v; }

      // 2) imágenes
      for (i = 0; i < cs.length; i++) {
        if (!imageAvailable(cs[i].image)) {
          v.status = age - base < 1 ? 'ErrImagePull' : 'ImagePullBackOff';
          v.events.push('Failed to pull image "' + cs[i].image + '": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/' + cs[i].image + '": not found');
          v.events.push('Error: ErrImagePull');
          if (v.status === 'ImagePullBackOff') v.events.push('Back-off pulling image "' + cs[i].image + '"');
          v.problems.push('image:' + cs[i].image);
          return v;
        }
      }
      // 3) configuración
      for (i = 0; i < cs.length; i++) {
        var refs = cs[i].envFrom || [];
        for (var j = 0; j < refs.length; j++) {
          var r = refs[j];
          if (r.configMapRef && !get('configmap', ns, r.configMapRef.name)) { v.status = 'CreateContainerConfigError'; v.events.push('Error: configmap "' + r.configMapRef.name + '" not found'); v.problems.push('configmap:' + r.configMapRef.name); return v; }
          if (r.secretRef && !get('secret', ns, r.secretRef.name)) { v.status = 'CreateContainerConfigError'; v.events.push('Error: secret "' + r.secretRef.name + '" not found'); v.problems.push('secret:' + r.secretRef.name); return v; }
        }
        var env = cs[i].env || [];
        for (j = 0; j < env.length; j++) {
          var vf = env[j].valueFrom || {};
          if (vf.configMapKeyRef && !get('configmap', ns, vf.configMapKeyRef.name)) { v.status = 'CreateContainerConfigError'; v.events.push('Error: configmap "' + vf.configMapKeyRef.name + '" not found'); return v; }
          if (vf.secretKeyRef && !get('secret', ns, vf.secretKeyRef.name)) { v.status = 'CreateContainerConfigError'; v.events.push('Error: secret "' + vf.secretKeyRef.name + '" not found'); return v; }
        }
      }
      // 4) arrancando
      if (age - base < 1) { v.status = 'ContainerCreating'; v.events.push('Pulled image, Created container, Started container'); return v; }

      // 5) memoria (Spring Boot con menos de 256Mi muere por OOM)
      for (i = 0; i < cs.length; i++) {
        var lim = cs[i].resources && cs[i].resources.limits && parseMem(cs[i].resources.limits.memory);
        if (/^catalogo/.test(cs[i].image || '') && lim != null && lim < 256 * 1024 * 1024) {
          v.restarts = Math.max(0, Math.floor((age - base) / 2));
          v.status = (age - base) % 3 === 2 ? 'OOMKilled' : (v.restarts ? 'CrashLoopBackOff' : 'Running');
          v.events.push('Back-off restarting failed container ' + cs[i].name + ' in pod ' + p.metadata.name);
          v.events.push('Last State: Terminated, Reason: OOMKilled, Exit Code: 137');
          v.problems.push('oom:' + cs[i].name);
          return v;
        }
      }

      // 6) running + readiness
      var ready = 0;
      for (i = 0; i < cs.length; i++) {
        var c = cs[i];
        var isSpring = /^catalogo/.test(c.image || '');
        var started = !isSpring || age - base >= 2; // Spring tarda en arrancar
        var rp = c.readinessProbe;
        var ok = started;
        if (rp && rp.httpGet) {
          var path = rp.httpGet.path || '/';
          if (isSpring && !/^\/actuator\/health/.test(path)) { ok = false; v.events.push('Readiness probe failed: HTTP probe failed with statuscode: 404 (' + path + ')'); v.problems.push('readiness:' + path); }
          var port = rp.httpGet.port;
          var ports = (c.ports || []).map(function (pp) { return pp.name; }).concat((c.ports || []).map(function (pp) { return pp.containerPort; }));
          if (typeof port === 'string' && ports.indexOf(port) < 0 && isNaN(parseInt(port, 10))) { ok = false; v.events.push('Readiness probe errored: port "' + port + '" not found in container'); }
        }
        if (ok) ready++;
      }
      v.ready = ready;
      v.status = 'Running';
      return v;
    }

    function containerPortNumber(pod, portRef) {
      if (typeof portRef === 'number') return portRef;
      if (/^\d+$/.test(String(portRef))) return parseInt(portRef, 10);
      var cs = (pod.spec && pod.spec.containers) || [];
      for (var i = 0; i < cs.length; i++) {
        var ps = cs[i].ports || [];
        for (var j = 0; j < ps.length; j++) if (ps[j].name === portRef) return ps[j].containerPort;
      }
      return null;
    }

    function selectorMatches(sel, labels) {
      if (!sel) return false;
      var ml = sel.matchLabels || sel;
      var keys = Object.keys(ml);
      if (!keys.length) return false;
      labels = labels || {};
      return keys.every(function (k) { return labels[k] === ml[k]; });
    }

    function serviceEndpoints(svc) {
      var ns = svc.metadata.namespace;
      var out = [];
      list('pod', ns).forEach(function (p) {
        if (!selectorMatches(svc.spec.selector, p.metadata.labels)) return;
        var v = podView(p);
        if (v.status !== 'Running' || v.ready < v.total) return;
        (svc.spec.ports || []).forEach(function (sp) {
          var tp = containerPortNumber(p, sp.targetPort == null ? sp.port : sp.targetPort);
          if (tp != null) out.push(p._sim.ip + ':' + tp);
        });
      });
      return out;
    }

    function ensureClusterIP(svc) {
      if (!svc.spec.clusterIP) svc.spec.clusterIP = '10.96.' + (hash(svc.metadata.name) % 250 + 1) + '.' + (hash(svc.metadata.namespace + svc.metadata.name) % 250 + 1);
      if (svc.spec.type === 'NodePort' || svc.spec.type === 'LoadBalancer') {
        (svc.spec.ports || []).forEach(function (p) { if (!p.nodePort) p.nodePort = 30000 + hash(svc.metadata.name + p.port) % 2767; });
      }
    }

    // ----- aplicar manifiestos -----
    function applyDoc(doc, opts) {
      opts = opts || {};
      if (!doc || typeof doc !== 'object') return { error: 'error: el documento YAML está vacío o no es un objeto' };
      if (!doc.kind) return { error: 'error: Object \'Kind\' is missing in \'' + JSON.stringify(doc).slice(0, 60) + '\'' };
      var kind = kindOf(doc.kind);
      if (!kind || KINDS[kind].derived) return { error: 'error: resource mapping not found for kind "' + doc.kind + '": el simulador no conoce ese recurso' };
      if (!doc.metadata || !doc.metadata.name) return { error: 'error: resource name may not be empty (' + doc.kind + ')' };
      var ns = KINDS[kind].ns ? (opts.ns || doc.metadata.namespace || S.ns) : undefined;
      if (KINDS[kind].ns) {
        if (opts.ns && doc.metadata.namespace && doc.metadata.namespace !== opts.ns) {
          return { error: 'error: the namespace from the provided object "' + doc.metadata.namespace + '" does not match the namespace "' + opts.ns + '". You must pass \'--namespace=' + doc.metadata.namespace + '\' to perform this operation.' };
        }
        if (!nsExists(ns)) return { error: 'Error from server (NotFound): error when creating "' + (opts.file || 'STDIN') + '": namespaces "' + ns + '" not found' };
      }
      // validaciones básicas por tipo
      if (kind === 'deployment') {
        var sel = doc.spec && doc.spec.selector && doc.spec.selector.matchLabels;
        var tl = doc.spec && doc.spec.template && doc.spec.template.metadata && doc.spec.template.metadata.labels;
        if (!sel) return { error: 'The Deployment "' + doc.metadata.name + '" is invalid: spec.selector: Required value' };
        if (!selectorMatches({ matchLabels: sel }, tl)) return { error: 'The Deployment "' + doc.metadata.name + '" is invalid: spec.template.metadata.labels: Invalid value: ' + JSON.stringify(tl || {}) + ': `selector` does not match template `labels`' };
      }
      var existing = get(kind, ns, doc.metadata.name);
      var obj = deepClone(doc);
      obj.metadata.namespace = ns;
      obj.metadata.labels = obj.metadata.labels || {};
      if (kind === 'secret' && obj.stringData) { obj.data = obj.data || {}; Object.keys(obj.stringData).forEach(function (k) { obj.data[k] = b64(String(obj.stringData[k])); }); delete obj.stringData; }
      obj._sim = existing ? existing._sim : { created: S.tick };
      if (existing && kind === 'deployment') obj._sim.revision = existing._sim.revision;
      if (kind === 'pod' && !existing) placePod(obj);
      if (kind === 'pod' && existing && JSON.stringify(existing.spec) !== JSON.stringify(obj.spec)) {
        return { error: 'The Pod "' + doc.metadata.name + '" is invalid: spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`, `spec.initContainers[*].image`, `spec.activeDeadlineSeconds`, `spec.tolerations` (only additions to existing tolerations) or `spec.terminationGracePeriodSeconds`' };
      }
      if (kind === 'service') ensureClusterIP(obj);
      var unchanged = existing && JSON.stringify(stripSim(existing)) === JSON.stringify(stripSim(obj));
      put(kind, obj);
      var verb = unchanged ? 'unchanged' : (existing ? 'configured' : 'created');
      return { line: KINDS[kind].res + '/' + doc.metadata.name + ' ' + verb };
    }
    function stripSim(o) { var c = deepClone(o); delete c._sim; delete c.status; return c; }
    function b64(s) {
      if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
      return Buffer.from(s, 'utf8').toString('base64');
    }

    function loadDocs(text) {
      var docs;
      try { docs = yaml.loadAll(text); }
      catch (e) { return { error: 'error: error parsing YAML: ' + (e.reason || e.message) + (e.mark ? ' (línea ' + (e.mark.line + 1) + ')' : '') }; }
      return { docs: docs.filter(function (d) { return d != null; }) };
    }

    // ----- vistas -----
    function viewRows(kind, items, flags) {
      var wide = flags.o === 'wide';
      var rows = [], header;
      var showNs = flags.A;
      function nsCol(o) { return showNs ? [o.metadata.namespace] : []; }
      switch (kind) {
        case 'pod':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE']).concat(wide ? ['IP', 'NODE'] : []);
          items.forEach(function (p) { var v = podView(p); rows.push(nsCol(p).concat([p.metadata.name, v.ready + '/' + v.total, v.status, v.restarts, ageOf(v.age)]).concat(wide ? [v.status === 'Running' || /Crash|OOM|Init|Initializing/.test(v.status) ? p._sim.ip : '<none>', p._sim.node] : [])); });
          break;
        case 'deployment':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE']).concat(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : []);
          items.forEach(function (d) {
            var st = deployStatus(d);
            var cs = (d.spec.template.spec.containers || []);
            rows.push(nsCol(d).concat([d.metadata.name, st.ready + '/' + st.desired, st.desired, st.ready, ageOf(S.tick - d._sim.created)]).concat(wide ? [cs.map(function (c) { return c.name; }).join(','), cs.map(function (c) { return c.image; }).join(','), labelStr(d.spec.selector.matchLabels)] : []));
          });
          break;
        case 'replicaset':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE']);
          items.forEach(function (rs) {
            var pods = list('pod', rs.metadata.namespace).filter(function (p) { return p._sim.owner === rs.metadata.name; });
            var ready = pods.filter(function (p) { var v = podView(p); return v.status === 'Running' && v.ready === v.total; }).length;
            rows.push(nsCol(rs).concat([rs.metadata.name, rs.spec.replicas, pods.length, ready, ageOf(S.tick - rs._sim.created)]));
          });
          break;
        case 'service':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE']).concat(wide ? ['SELECTOR'] : []);
          items.forEach(function (s) {
            ensureClusterIP(s);
            var ports = (s.spec.ports || []).map(function (p) { return p.port + (p.nodePort ? ':' + p.nodePort : '') + '/' + (p.protocol || 'TCP'); }).join(',');
            rows.push(nsCol(s).concat([s.metadata.name, s.spec.type || 'ClusterIP', s.spec.clusterIP, s.spec.type === 'LoadBalancer' ? '<pending>' : '<none>', ports, ageOf(S.tick - s._sim.created)]).concat(wide ? [labelStr(s.spec.selector) || '<none>'] : []));
          });
          break;
        case 'endpoints':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'ENDPOINTS', 'AGE']);
          items.forEach(function (s) { var eps = s.metadata.name === 'kubernetes' ? ['172.18.0.3:6443'] : serviceEndpoints(s); rows.push(nsCol(s).concat([s.metadata.name, eps.length ? eps.join(',') : '<none>', ageOf(S.tick - s._sim.created)])); });
          break;
        case 'configmap':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'DATA', 'AGE']);
          items.forEach(function (c) { rows.push(nsCol(c).concat([c.metadata.name, Object.keys(c.data || {}).length, ageOf(S.tick - c._sim.created)])); });
          break;
        case 'secret':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'TYPE', 'DATA', 'AGE']);
          items.forEach(function (c) { rows.push(nsCol(c).concat([c.metadata.name, c.type || 'Opaque', Object.keys(c.data || {}).length, ageOf(S.tick - c._sim.created)])); });
          break;
        case 'ingress':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE']);
          items.forEach(function (i) { rows.push(nsCol(i).concat([i.metadata.name, i.spec.ingressClassName || '<none>', (i.spec.rules || []).map(function (r) { return r.host || '*'; }).join(','), S.installed['ingress-nginx'] ? 'localhost' : '', '80', ageOf(S.tick - i._sim.created)])); });
          break;
        case 'horizontalpodautoscaler':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE']);
          items.forEach(function (h) {
            var ref = h.spec.scaleTargetRef || {};
            var target = get('deployment', h.metadata.namespace, ref.name);
            var pct = ((h.spec.metrics || [])[0] || {}).resource; pct = pct && pct.target && pct.target.averageUtilization;
            var cur = S.installed['metrics-server'] && target ? (3 + hash(h.metadata.name + S.tick) % 9) + '%' : '<unknown>';
            rows.push(nsCol(h).concat([h.metadata.name, ref.kind + '/' + ref.name, 'cpu: ' + cur + '/' + (pct || 80) + '%', h.spec.minReplicas || 1, h.spec.maxReplicas, target ? (target.spec.replicas == null ? 1 : target.spec.replicas) : 0, ageOf(S.tick - h._sim.created)]));
          });
          break;
        case 'resourcequota':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'AGE', 'REQUEST', 'LIMIT']);
          items.forEach(function (q) { var u = quotaUsage(q); rows.push(nsCol(q).concat([q.metadata.name, ageOf(S.tick - q._sim.created), u.request, u.limit])); });
          break;
        case 'limitrange':
          header = (showNs ? ['NAMESPACE'] : []).concat(['NAME', 'CREATED AT']);
          items.forEach(function (l) { rows.push(nsCol(l).concat([l.metadata.name, new Date().toISOString().replace(/\.\d+Z/, 'Z')])); });
          break;
        case 'namespace':
          header = ['NAME', 'STATUS', 'AGE'];
          items.forEach(function (n) { rows.push([n.metadata.name, 'Active', ageOf(S.tick - n._sim.created)]); });
          break;
        case 'node':
          header = ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'].concat(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : []);
          S.cluster.nodes.forEach(function (n, i) { rows.push([n.name, 'Ready', n.role === 'control-plane' ? 'control-plane' : '<none>', ageOf(S.tick - S.cluster.created), 'v1.31.2'].concat(wide ? ['172.18.0.' + (i + 2), '<none>', 'Debian GNU/Linux 12 (bookworm)', '5.15.167.4-microsoft-standard-WSL2', 'containerd://1.7.18'] : [])); });
          break;
      }
      if (flags['show-labels']) { header.push('LABELS'); rows.forEach(function (r, i) { r.push(labelStr(items[i].metadata.labels) || '<none>'); }); }
      return [header].concat(rows);
    }
    function labelStr(l) { return Object.keys(l || {}).map(function (k) { return k + '=' + l[k]; }).join(','); }

    function deployStatus(d) {
      var ns = d.metadata.namespace;
      var pods = list('pod', ns).filter(function (p) { var rs = get('replicaset', ns, p._sim.owner); return rs && rs._sim.owner === d.metadata.name; });
      var ready = pods.filter(function (p) { var v = podView(p); return v.status === 'Running' && v.ready === v.total; }).length;
      return { desired: d.spec.replicas == null ? 1 : d.spec.replicas, ready: ready, pods: pods };
    }

    function quotaUsage(q) {
      var ns = q.metadata.namespace;
      var pods = list('pod', ns);
      var reqCpu = 0, reqMem = 0, limMem = 0;
      pods.forEach(function (p) { (p.spec.containers || []).forEach(function (c) { var r = c.resources || {}; reqCpu += parseCpu((r.requests || {}).cpu) || 100; reqMem += parseMem((r.requests || {}).memory) || 128 * 1024 * 1024; limMem += parseMem((r.limits || {}).memory) || 256 * 1024 * 1024; }); });
      var hard = q.spec.hard || {};
      var fmtMem = function (b) { return Math.round(b / (1024 * 1024)) + 'Mi'; };
      return {
        request: 'requests.cpu: ' + reqCpu + 'm/' + (hard['requests.cpu'] || '-') + ', requests.memory: ' + fmtMem(reqMem) + '/' + (hard['requests.memory'] || '-') + ', pods: ' + pods.length + '/' + (hard.pods || '-'),
        limit: 'limits.memory: ' + fmtMem(limMem) + '/' + (hard['limits.memory'] || '-')
      };
    }

    function toYaml(o) {
      var c = deepClone(o);
      var sim = c._sim; delete c._sim;
      if (c.kind === 'Pod' && sim) {
        var v = podView(o);
        c.spec.nodeName = sim.node;
        c.status = { phase: v.status === 'Running' ? 'Running' : (v.status.indexOf('Init') === 0 || v.status === 'ContainerCreating' || /Image|Config/.test(v.status) ? 'Pending' : 'Running'), podIP: sim.ip, hostIP: '172.18.0.3', containerStatuses: (o.spec.containers || []).map(function (cc) { return { name: cc.name, image: cc.image, ready: v.status === 'Running' && v.ready === v.total, restartCount: v.restarts, state: v.status === 'Running' ? { running: { startedAt: 'now' } } : { waiting: { reason: v.status } } }; }) };
      }
      if (c.kind === 'Deployment' && sim) { var st = deployStatus(o); c.status = { replicas: st.pods.length, readyReplicas: st.ready, availableReplicas: st.ready, updatedReplicas: st.pods.length, observedGeneration: sim.revision || 1 }; }
      c.metadata.creationTimestamp = 'hace ' + ageOf(S.tick - (sim ? sim.created : 0));
      return yaml.dump(c, { noRefs: true, lineWidth: 120 }).replace(/\n$/, '');
    }

    // ----- describe -----
    function describe(kind, o) {
      var out = [];
      var ns = o.metadata.namespace;
      out.push('Name:         ' + o.metadata.name);
      if (ns) out.push('Namespace:    ' + ns);
      out.push('Labels:       ' + (labelStr(o.metadata.labels) || '<none>'));
      if (kind === 'pod') {
        var v = podView(o);
        out.push('Node:         ' + o._sim.node + '/172.18.0.3');
        out.push('Status:       ' + (v.status === 'Running' ? 'Running' : /Image|Config|Init|Creating/.test(v.status) ? 'Pending' : 'Running'));
        out.push('IP:           ' + o._sim.ip);
        if (o._sim.owner) out.push('Controlled By:  ReplicaSet/' + o._sim.owner);
        (o.spec.initContainers || []).length && out.push('Init Containers:');
        (o.spec.initContainers || []).forEach(function (c) { out.push('  ' + c.name + ':'); out.push('    Image:      ' + c.image); out.push('    Command:    ' + JSON.stringify(c.command || [])); out.push('    State:      ' + (v.status.indexOf('Init') === 0 ? 'Running' : 'Terminated (Completed)')); });
        out.push('Containers:');
        (o.spec.containers || []).forEach(function (c) {
          out.push('  ' + c.name + ':');
          out.push('    Image:          ' + c.image);
          out.push('    Port:           ' + ((c.ports || []).map(function (p) { return p.containerPort + '/' + (p.protocol || 'TCP'); }).join(', ') || '<none>'));
          out.push('    State:          ' + (v.status === 'Running' ? 'Running' : 'Waiting'));
          if (v.status !== 'Running') out.push('      Reason:       ' + v.status);
          if (v.restarts) { out.push('    Last State:     Terminated'); out.push('      Reason:       OOMKilled'); out.push('      Exit Code:    137'); }
          out.push('    Ready:          ' + (v.status === 'Running' && v.ready === v.total));
          out.push('    Restart Count:  ' + v.restarts);
          var r = c.resources || {};
          if (r.limits) out.push('    Limits:         ' + Object.keys(r.limits).map(function (k) { return k + ': ' + r.limits[k]; }).join(', '));
          if (r.requests) out.push('    Requests:       ' + Object.keys(r.requests).map(function (k) { return k + ': ' + r.requests[k]; }).join(', '));
          ['startupProbe', 'livenessProbe', 'readinessProbe'].forEach(function (pn) { var pr = c[pn]; if (pr && pr.httpGet) out.push('    ' + pad(pn.replace('Probe', '') + ':', 16) + 'http-get http://:' + pr.httpGet.port + pr.httpGet.path + ' delay=' + (pr.initialDelaySeconds || 0) + 's timeout=1s period=' + (pr.periodSeconds || 10) + 's #success=1 #failure=' + (pr.failureThreshold || 3)); });
          if (c.envFrom) out.push('    Environment Variables from:'); (c.envFrom || []).forEach(function (e) { if (e.configMapRef) out.push('      ' + e.configMapRef.name + '  ConfigMap  Optional: false'); if (e.secretRef) out.push('      ' + e.secretRef.name + '  Secret  Optional: false'); });
          if (c.env && c.env.length) { out.push('    Environment:'); c.env.forEach(function (e) { out.push('      ' + e.name + ':  ' + (e.value != null ? e.value : '<set from ' + JSON.stringify(e.valueFrom) + '>')); }); }
          if (c.volumeMounts) { out.push('    Mounts:'); c.volumeMounts.forEach(function (m) { out.push('      ' + m.mountPath + ' from ' + m.name + ' (' + (m.readOnly ? 'ro' : 'rw') + ')'); }); }
        });
        out.push('Conditions:');
        out.push('  Type              Status');
        out.push('  Initialized       ' + (v.status.indexOf('Init') !== 0));
        out.push('  Ready             ' + (v.status === 'Running' && v.ready === v.total));
        out.push('  ContainersReady   ' + (v.status === 'Running' && v.ready === v.total));
        out.push('  PodScheduled      True');
        out.push('Events:');
        out.push('  Type     Reason     Age   From               Message');
        out.push('  ----     ------     ----  ----               -------');
        out.push('  Normal   Scheduled  ' + pad(ageOf(v.age), 5) + ' default-scheduler  Successfully assigned ' + ns + '/' + o.metadata.name + ' to ' + o._sim.node);
        if (!v.events.length) { out.push('  Normal   Pulled     ' + pad(ageOf(v.age), 5) + ' kubelet            Container image "' + ((o.spec.containers || [])[0] || {}).image + '" already present on machine'); out.push('  Normal   Created    ' + pad(ageOf(v.age), 5) + ' kubelet            Created container ' + ((o.spec.containers || [])[0] || {}).name); out.push('  Normal   Started    ' + pad(ageOf(v.age), 5) + ' kubelet            Started container ' + ((o.spec.containers || [])[0] || {}).name); }
        v.events.forEach(function (e) { out.push('  Warning  ' + pad(/Back-off/.test(e) ? 'BackOff' : /probe/i.test(e) ? 'Unhealthy' : 'Failed', 10) + ' ' + pad(ageOf(Math.max(0, v.age - 1)), 5) + ' kubelet            ' + e); });
        return out;
      }
      if (kind === 'deployment') {
        var st = deployStatus(o);
        out.push('Selector:               ' + labelStr(o.spec.selector.matchLabels));
        out.push('Replicas:               ' + st.desired + ' desired | ' + st.pods.length + ' updated | ' + st.pods.length + ' total | ' + st.ready + ' available | ' + (st.desired - st.ready) + ' unavailable');
        out.push('StrategyType:           ' + ((o.spec.strategy || {}).type || 'RollingUpdate'));
        var ru = (o.spec.strategy || {}).rollingUpdate || {};
        out.push('RollingUpdateStrategy:  ' + (ru.maxUnavailable == null ? '25%' : ru.maxUnavailable) + ' max unavailable, ' + (ru.maxSurge == null ? '25%' : ru.maxSurge) + ' max surge');
        out.push('Pod Template:');
        out.push('  Labels:  ' + labelStr(o.spec.template.metadata.labels));
        out.push('  Containers:');
        (o.spec.template.spec.containers || []).forEach(function (c) { out.push('   ' + c.name + ':'); out.push('    Image:  ' + c.image); out.push('    Port:   ' + ((c.ports || []).map(function (p) { return p.containerPort + '/TCP'; }).join(', ') || '<none>')); });
        out.push('Conditions:');
        out.push('  Type           Status  Reason');
        out.push('  ----           ------  ------');
        out.push('  Available      ' + (st.ready >= st.desired ? 'True    MinimumReplicasAvailable' : 'False   MinimumReplicasUnavailable'));
        out.push('  Progressing    True    NewReplicaSetAvailable');
        var rss = list('replicaset', ns).filter(function (r) { return r._sim.owner === o.metadata.name; });
        var newRs = rss.filter(function (r) { return r.spec.replicas > 0; })[0];
        out.push('OldReplicaSets:  ' + (rss.filter(function (r) { return r !== newRs; }).map(function (r) { return r.metadata.name + ' (0/0 replicas created)'; }).join(', ') || '<none>'));
        out.push('NewReplicaSet:   ' + (newRs ? newRs.metadata.name + ' (' + st.pods.length + '/' + st.desired + ' replicas created)' : '<none>'));
        out.push('Events:');
        out.push('  Type    Reason             Age   From                   Message');
        out.push('  ----    ------             ----  ----                   -------');
        rss.forEach(function (r) { out.push('  Normal  ScalingReplicaSet  ' + pad(ageOf(S.tick - r._sim.created), 5) + ' deployment-controller  Scaled up replica set ' + r.metadata.name + ' to ' + (r.spec.replicas || st.desired)); });
        return out;
      }
      if (kind === 'service') {
        ensureClusterIP(o);
        out.push('Selector:          ' + (labelStr(o.spec.selector) || '<none>'));
        out.push('Type:              ' + (o.spec.type || 'ClusterIP'));
        out.push('IP:                ' + o.spec.clusterIP);
        (o.spec.ports || []).forEach(function (p) { out.push('Port:              ' + (p.name || '<unset>') + '  ' + p.port + '/' + (p.protocol || 'TCP')); out.push('TargetPort:        ' + (p.targetPort == null ? p.port : p.targetPort) + '/' + (p.protocol || 'TCP')); if (p.nodePort) out.push('NodePort:          ' + (p.name || '<unset>') + '  ' + p.nodePort + '/TCP'); });
        var eps = serviceEndpoints(o);
        out.push('Endpoints:         ' + (eps.length ? eps.join(',') : '<none>'));
        if (!eps.length && o.spec.selector) {
          var matching = list('pod', ns).filter(function (p) { return selectorMatches(o.spec.selector, p.metadata.labels); });
          out.push('Events:            <none>');
          out.push('');
          out.push(matching.length ? '# Pista del simulador: hay ' + matching.length + ' pod(s) con esas labels pero ninguno está Ready. Revisa kubectl get pods.' : '# Pista del simulador: ningún Pod tiene las labels ' + labelStr(o.spec.selector) + '. Compara con kubectl get pods --show-labels.');
        } else out.push('Events:            <none>');
        return out;
      }
      if (kind === 'resourcequota') {
        var u = quotaUsage(o);
        out.push('Resource          Used     Hard');
        out.push('--------          ----     ----');
        u.request.split(', ').concat(u.limit.split(', ')).forEach(function (part) { var m = part.match(/^(\S+): (\S+)\/(\S+)$/); if (m) out.push(pad(m[1], 18) + pad(m[2], 9) + m[3]); });
        return out;
      }
      if (kind === 'namespace') { out.push('Status:       Active'); out.push(''); var qs = list('resourcequota', o.metadata.name); out.push(qs.length ? 'Resource Quotas' : 'No resource quota.'); qs.forEach(function (q) { out.push('  Name:  ' + q.metadata.name); }); var ls = list('limitrange', o.metadata.name); out.push(ls.length ? 'Resource Limits' : 'No LimitRange resource.'); ls.forEach(function (l) { out.push('  Name:  ' + l.metadata.name); (l.spec.limits || []).forEach(function (lim) { out.push('  Type: ' + lim.type + '  defaultRequest: ' + JSON.stringify(lim.defaultRequest || {}) + '  default: ' + JSON.stringify(lim['default'] || {})); }); }); return out; }
      // genérico
      out.push('API Version:  ' + o.apiVersion);
      out.push('Kind:         ' + o.kind);
      toYaml(o).split('\n').forEach(function (l) { if (!/^(apiVersion|kind):/.test(l)) out.push(l); });
      return out;
    }

    // ----- logs -----
    function logsFor(pod, container, ns) {
      var v = podView(pod);
      var cs = pod.spec.containers || [], ics = pod.spec.initContainers || [];
      var all = cs.concat(ics);
      var c;
      if (container) {
        c = all.filter(function (x) { return x.name === container; })[0];
        if (!c) return { error: 'error: container ' + container + ' is not valid for pod ' + pod.metadata.name };
      } else {
        if (cs.length > 1) return { error: 'error: a container name must be specified for pod ' + pod.metadata.name + ', choose one of: [' + cs.map(function (x) { return x.name; }).join(' ') + ']' + (ics.length ? ' or one of the init containers: [' + ics.map(function (x) { return x.name; }).join(' ') + ']' : '') };
        c = cs[0];
      }
      var isInit = ics.indexOf(c) >= 0;
      if (isInit) {
        if (v.status.indexOf('Init') === 0) { var m = (c.command || []).join(' ').match(/echo ([^;]+);/); var msg = m ? m[1].trim() : 'esperando'; var lines = []; for (var i = 0; i < Math.min(8, v.age + 1); i++) lines.push(msg); return { lines: lines }; }
        return { lines: [] };
      }
      if (/Image/.test(v.status)) return { error: 'Error from server (BadRequest): container "' + c.name + '" in pod "' + pod.metadata.name + '" is waiting to start: trying and failing to pull image' };
      if (v.status === 'CreateContainerConfigError') return { error: 'Error from server (BadRequest): container "' + c.name + '" in pod "' + pod.metadata.name + '" is waiting to start: CreateContainerConfigError' };
      if (v.status === 'ContainerCreating' || v.status === 'PodInitializing') return { error: 'Error from server (BadRequest): container "' + c.name + '" in pod "' + pod.metadata.name + '" is waiting to start: ContainerCreating' };
      if (/^catalogo/.test(c.image || '')) {
        var env = resolveEnv(pod, c);
        var l = [
          '',
          '  .   ____          _            __ _ _',
          ' /\\\\ / ___\'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\',
          '( ( )\\___ | \'_ | \'_| | \'_ \\/ _` | \\ \\ \\ \\',
          ' \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )',
          '  \'  |____| .__|_| |_|_| |_\\__, | / / / /',
          ' =========|_|==============|___/=/_/_/_/',
          '',
          ' :: Spring Boot ::                (v3.3.5)',
          '',
          'INFO 1 --- [catalogo] [           main] g.e.u.c.CatalogoApplication              : Starting CatalogoApplication v1.0.0 using Java 21.0.5 with PID 1 (/app/application.jar started by 1001 in /app)',
          'INFO 1 --- [catalogo] [           main] g.e.u.c.CatalogoApplication              : The following 1 profile is active: "' + (env.SPRING_PROFILES_ACTIVE || 'default') + '"',
          'INFO 1 --- [catalogo] [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat initialized with port 8080 (http)'
        ];
        if (v.problems.some(function (p) { return p.indexOf('oom:') === 0; })) {
          l.push('INFO 1 --- [catalogo] [           main] o.s.b.w.s.c.ServletWebServerApplicationContext : Root WebApplicationContext: initialization completed in 2731 ms');
          l.push('Terminating due to java.lang.OutOfMemoryError: Java heap space');
          l.push('# El contenedor fue terminado con exit code 137 (OOMKilled). Sube resources.limits.memory.');
          return { lines: l };
        }
        l.push('INFO 1 --- [catalogo] [           main] o.s.b.a.e.web.EndpointLinksResolver      : Exposing 3 endpoints beneath base path \'/actuator\'');
        l.push('INFO 1 --- [catalogo] [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port 8080 (http) with context path \'/\'');
        l.push('INFO 1 --- [catalogo] [           main] g.e.u.c.CatalogoApplication              : Started CatalogoApplication in 4.218 seconds (process running for 4.9)');
        l.push('INFO 1 --- [catalogo] [           main] g.e.u.c.SaludoController                 : APP_SALUDO=' + (env.APP_SALUDO || 'Hola desde el default'));
        if (v.problems.some(function (p) { return p.indexOf('readiness:') === 0; })) l.push('WARN 1 --- [catalogo] [nio-8080-exec-1] o.s.web.servlet.PageNotFound             : No mapping for GET ' + v.problems.filter(function (p) { return p.indexOf('readiness:') === 0; })[0].slice(10));
        return { lines: l };
      }
      var cmdStr = (c.command || []).concat(c.args || []).join(' ');
      if (/tail .*F/.test(cmdStr)) return { lines: ['INFO  g.e.u.c.CatalogoApplication : Started CatalogoApplication in 4.218 seconds', 'INFO  g.e.u.c.SaludoController    : GET / -> 200', 'INFO  g.e.u.c.SaludoController    : GET /actuator/health -> 200', '# (sidecar) reenviando /var/log/app/catalogo.log ...'] };
      if (/postgres/.test(c.image || '')) return { lines: ['PostgreSQL init process complete; ready for start up.', 'LOG:  database system is ready to accept connections'] };
      if (/nginx/.test(c.image || '')) return { lines: ['/docker-entrypoint.sh: Configuration complete; ready for start up', '2024/01/01 00:00:00 [notice] 1#1: start worker processes'] };
      return { lines: ['# ' + c.image + ' no escribe nada a stdout en este simulador.'] };
    }

    function resolveEnv(pod, c) {
      var ns = pod.metadata.namespace, env = {};
      (c.envFrom || []).forEach(function (e) {
        if (e.configMapRef) { var cm = get('configmap', ns, e.configMapRef.name); if (cm) Object.assign(env, cm.data || {}); }
        if (e.secretRef) { var sc = get('secret', ns, e.secretRef.name); if (sc) Object.keys(sc.data || {}).forEach(function (k) { env[k] = fromB64(sc.data[k]); }); }
      });
      (c.env || []).forEach(function (e) {
        if (e.value != null) env[e.name] = String(e.value);
        else if (e.valueFrom && e.valueFrom.configMapKeyRef) { var cm2 = get('configmap', ns, e.valueFrom.configMapKeyRef.name); if (cm2) env[e.name] = (cm2.data || {})[e.valueFrom.configMapKeyRef.key]; }
        else if (e.valueFrom && e.valueFrom.secretKeyRef) { var s2 = get('secret', ns, e.valueFrom.secretKeyRef.name); if (s2) env[e.name] = fromB64((s2.data || {})[e.valueFrom.secretKeyRef.key] || ''); }
      });
      return env;
    }
    function fromB64(s) { try { return typeof atob === 'function' ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, 'base64').toString('utf8'); } catch (e) { return s; } }

    // ----- parseo de flags de kubectl -----
    function parseKubectl(args) {
      var flags = { A: false, o: null, n: null, l: null, f: [], c: null, 'show-labels': false, dryRun: null, extra: {}, positional: [], passthrough: null };
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === '--') { flags.passthrough = args.slice(i + 1); break; }
        var m;
        if (a === '-A' || a === '--all-namespaces') flags.A = true;
        else if (a === '-n' || a === '--namespace') flags.n = args[++i];
        else if ((m = a.match(/^--namespace=(.*)$/)) || (m = a.match(/^-n(.+)$/))) flags.n = m[1];
        else if (a === '-o' || a === '--output') flags.o = args[++i];
        else if ((m = a.match(/^-o(.+)$/)) || (m = a.match(/^--output=(.*)$/))) flags.o = m[1];
        else if (a === '-l' || a === '--selector') flags.l = args[++i];
        else if ((m = a.match(/^-l(.+)$/)) || (m = a.match(/^--selector=(.*)$/))) flags.l = m[1];
        else if (a === '-f' || a === '--filename') flags.f.push(args[++i]);
        else if ((m = a.match(/^--filename=(.*)$/)) || (m = a.match(/^-f(.+)$/))) flags.f.push(m[1]);
        else if (a === '-c' || a === '--container') flags.c = args[++i];
        else if ((m = a.match(/^-c(.+)$/)) || (m = a.match(/^--container=(.*)$/))) flags.c = m[1];
        else if (a === '--show-labels') flags['show-labels'] = true;
        else if (a === '--dry-run') flags.dryRun = args[++i] || 'client';
        else if ((m = a.match(/^--dry-run=(.*)$/))) flags.dryRun = m[1];
        else if (a === '-w' || a === '--watch' || a === '-f' && false) flags.extra.watch = true;
        else if (a === '--follow') flags.extra.follow = true;
        else if ((m = a.match(/^--([a-zA-Z0-9-]+)=(.*)$/))) { if (flags.extra[m[1]] != null) flags.extra[m[1]] += ',' + m[2]; else flags.extra[m[1]] = m[2]; }
        else if ((m = a.match(/^--([a-zA-Z0-9-]+)$/))) { var nxt = args[i + 1]; if (nxt != null && nxt[0] !== '-' && ['replicas', 'image', 'port', 'target-port', 'type', 'name', 'from-literal', 'from-file', 'patch', 'type', 'for', 'timeout', 'labels', 'env', 'command', 'limits', 'requests', 'from'].indexOf(m[1]) >= 0) { flags.extra[m[1]] = args[++i]; } else flags.extra[m[1]] = true; }
        else if (a === '-p') flags.extra.patch = args[++i];
        else if (a === '-it' || a === '-ti' || a === '-i' || a === '-t' || a === '--rm' || a === '--stdin' || a === '--tty') flags.extra.interactive = true;
        else if (a[0] === '-' && a.length > 1 && !/^-\d/.test(a)) flags.extra[a.slice(1)] = true;
        else flags.positional.push(a);
      }
      return flags;
    }

    // Convierte "pods", "pod/x", "deploy,svc" y "pods x y" a [{kind, names}]
    function parseTargets(positional) {
      if (!positional.length) return { error: 'error: You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.' };
      var first = positional[0];
      var rest = positional.slice(1);
      var out = [];
      if (first.indexOf('/') >= 0 || positional.some(function (p) { return p.indexOf('/') >= 0; })) {
        for (var i = 0; i < positional.length; i++) {
          var parts = positional[i].split('/');
          var k = kindOf(parts[0]);
          if (!k) return { error: 'error: the server doesn\'t have a resource type "' + parts[0] + '"' };
          out.push({ kind: k, names: [parts[1]] });
        }
        return { targets: out };
      }
      var kinds = first.split(',');
      for (var j = 0; j < kinds.length; j++) {
        if (kinds[j] === 'all') { ['pod', 'service', 'deployment', 'replicaset', 'horizontalpodautoscaler'].forEach(function (k) { out.push({ kind: k, names: rest, all: true }); }); continue; }
        var kk = kindOf(kinds[j]);
        if (!kk) return { error: 'error: the server doesn\'t have a resource type "' + kinds[j] + '"' };
        out.push({ kind: kk, names: rest });
      }
      return { targets: out };
    }

    function needCluster() {
      if (!S.cluster) return ['E: The connection to the server localhost:8080 was refused - did you specify the right host or port?', '# Pista: no hay clúster. Créalo con: kind create cluster --name softav --config kind-config.yaml'];
      return null;
    }

    function matchesLabelSelector(sel, labels) {
      if (!sel) return true;
      labels = labels || {};
      return sel.split(',').every(function (term) {
        var m = term.match(/^([^!=]+)(!=|==|=)(.*)$/);
        if (m) return m[2] === '!=' ? labels[m[1]] !== m[3] : labels[m[1]] === m[3];
        if (term[0] === '!') return !(term.slice(1) in labels);
        return term in labels;
      });
    }

    // ----- kubectl -----
    function kubectl(args) {
      var sub = args[0];
      var flags = parseKubectl(args.slice(1));
      var ns = flags.n || S.ns;
      var out = [];
      var err;

      if (!sub || sub === '--help' || sub === '-h' || sub === 'help') return kubectlHelp();
      if (sub === 'version') return ['Client Version: v1.31.2', 'Kustomize Version: v5.4.2'].concat(S.cluster ? ['Server Version: v1.31.2'] : (flags.extra.client ? [] : ['The connection to the server localhost:8080 was refused - did you specify the right host or port?']));
      if (sub === 'api-resources') {
        var rows = [['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND']];
        Object.keys(KINDS).forEach(function (k) { var d = KINDS[k]; if (d.derived && k !== 'node' && k !== 'endpoints') return; rows.push([d.aliases[d.aliases.length - 1], d.aliases.filter(function (a) { return a.length <= 6 && a !== d.aliases[d.aliases.length - 1]; }).join(','), d.api, String(d.ns), d.Kind]); });
        return table(rows);
      }
      if (sub === 'explain') return explain(flags.positional[0], flags.extra.recursive);
      if (sub === 'config') {
        var cs = flags.positional[0];
        if (cs === 'set-context') { var target = flags.n || flags.extra.namespace; if (!target) return ['error: you must specify --namespace=<ns>']; S.ns = target; return ['Context "kind-' + (S.cluster ? S.cluster.name : 'softav') + '" modified.'].concat(S.cluster && !nsExists(target) ? ['# Ojo: el namespace "' + target + '" todavía no existe. Créalo con kubectl apply -f namespace.yaml'] : []); }
        if (cs === 'current-context') return S.cluster ? ['kind-' + S.cluster.name] : ['error: current-context is not set'];
        if (cs === 'get-contexts') return S.cluster ? table([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ['*', 'kind-' + S.cluster.name, 'kind-' + S.cluster.name, 'kind-' + S.cluster.name, S.ns]]) : table([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE']]);
        if (cs === 'view') return ['apiVersion: v1', 'kind: Config', 'current-context: ' + (S.cluster ? 'kind-' + S.cluster.name : '""'), 'contexts:'].concat(S.cluster ? ['- name: kind-' + S.cluster.name, '  context:', '    cluster: kind-' + S.cluster.name, '    namespace: ' + S.ns] : []);
        return ['error: unknown command "' + cs + '" for "kubectl config"'];
      }

      if ((err = needCluster())) return err;
      S.tick++;
      reconcile();

      if (flags.n && !nsExists(flags.n) && sub !== 'create' && sub !== 'apply') {
        if (sub === 'get') return ['No resources found in ' + flags.n + ' namespace.'];
      }

      switch (sub) {
        case 'cluster-info': return ['Kubernetes control plane is running at https://127.0.0.1:' + (40000 + hash(S.cluster.name) % 9999), 'CoreDNS is running at https://127.0.0.1:' + (40000 + hash(S.cluster.name) % 9999) + '/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy', '', 'To further debug and diagnose cluster problems, use \'kubectl cluster-info dump\'.'];
        case 'get': return cmdGet(flags, ns);
        case 'describe': return cmdDescribe(flags, ns);
        case 'apply': return cmdApply(flags, ns);
        case 'create': return cmdCreate(flags, ns);
        case 'run': return cmdRun(flags, ns);
        case 'expose': return cmdExpose(flags, ns);
        case 'delete': return cmdDelete(flags, ns);
        case 'scale': return cmdScale(flags, ns);
        case 'set': return cmdSet(flags, ns);
        case 'rollout': return cmdRollout(flags, ns);
        case 'logs': return cmdLogs(flags, ns);
        case 'exec': return cmdExec(flags, ns);
        case 'patch': return cmdPatch(flags, ns);
        case 'label': case 'annotate': return cmdLabel(flags, ns, sub);
        case 'port-forward': return cmdPortForward(flags, ns);
        case 'top': return S.installed['metrics-server'] ? cmdTop(flags, ns) : ['error: Metrics API not available', '# Pista: instala metrics-server (clase 4): kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml'];
        case 'wait': return ['# (simulador) condición "' + (flags.extra['for'] || 'condition=ready') + '" alcanzada.'];
        case 'edit': return ['error: el simulador no tiene editor interactivo.', 'Alternativas que sí funcionan aquí:', '  sed -i \'s/viejo/nuevo/\' archivo.yaml && kubectl apply -f archivo.yaml', '  kubectl set image deploy/NOMBRE CONTENEDOR=imagen:tag', '  kubectl set resources deploy/NOMBRE --limits=memory=512Mi', '  kubectl patch svc NOMBRE -p \'{"spec":{"selector":{"app":"correcto"}}}\'', '  kubectl scale deploy/NOMBRE --replicas=3'];
        case 'cp': case 'attach': case 'proxy': case 'auth': case 'cordon': case 'drain': case 'taint': return ['error: "kubectl ' + sub + '" no está implementado en el simulador. Úsalo en tu clúster real.'];
        default: return ['error: unknown command "' + sub + '" for "kubectl"', '', 'Run \'kubectl --help\' for usage.'];
      }
    }

    function kubectlHelp() {
      return [
        'kubectl controls the Kubernetes cluster manager. (simulador del curso)',
        '',
        'Comandos soportados:',
        '  get, describe, apply -f, create (namespace|deployment|configmap|secret), run, expose, delete,',
        '  scale, set image|resources|env, rollout status|history|restart|undo, logs, exec, patch, label,',
        '  port-forward, top, explain, config set-context|current-context, cluster-info, api-resources.',
        'Flags: -n/--namespace, -A, -o wide|yaml|json|name, -l selector, --show-labels, --dry-run=client -o yaml',
        '',
        'Escribe "help" para ver el flujo sugerido del curso.'
      ];
    }

    function explain(path, recursive) {
      if (!path) return ['You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.'];
      var docs = {
        'pod': ['KIND:       Pod', 'VERSION:    v1', '', 'DESCRIPTION:', '    Pod is a collection of containers that can run on a host. This resource is', '    created by clients and scheduled onto hosts.', '', 'FIELDS:', '  apiVersion\t<string>', '  kind\t<string>', '  metadata\t<ObjectMeta>', '  spec\t<PodSpec>', '  status\t<PodStatus>'],
        'pod.spec': ['KIND:       Pod', 'VERSION:    v1', '', 'FIELD: spec <PodSpec>', '', 'FIELDS:', '  containers\t<[]Container> -required-', '  initContainers\t<[]Container>', '  volumes\t<[]Volume>', '  restartPolicy\t<string>', '  nodeSelector\t<map[string]string>', '  serviceAccountName\t<string>', '  terminationGracePeriodSeconds\t<integer>', '  securityContext\t<PodSecurityContext>'],
        'pod.spec.containers': ['KIND:       Pod', 'VERSION:    v1', '', 'FIELD: containers <[]Container>', '', 'DESCRIPTION:', '    List of containers belonging to the pod. Containers cannot currently be', '    added or removed. There must be at least one container in a Pod.', '', 'FIELDS:', '  args\t<[]string>', '  command\t<[]string>', '  env\t<[]EnvVar>', '  envFrom\t<[]EnvFromSource>', '  image\t<string>', '  imagePullPolicy\t<string>', '  livenessProbe\t<Probe>', '  name\t<string> -required-', '  ports\t<[]ContainerPort>', '  readinessProbe\t<Probe>', '  resources\t<ResourceRequirements>', '  securityContext\t<SecurityContext>', '  startupProbe\t<Probe>', '  volumeMounts\t<[]VolumeMount>'],
        'pod.spec.containers.resources': ['FIELD: resources <ResourceRequirements>', '', 'FIELDS:', '  limits\t<map[string]Quantity>', '  requests\t<map[string]Quantity>'],
        'deployment': ['KIND:       Deployment', 'VERSION:    apps/v1', '', 'DESCRIPTION:', '    Deployment enables declarative updates for Pods and ReplicaSets.', '', 'FIELDS:', '  apiVersion\t<string>', '  kind\t<string>', '  metadata\t<ObjectMeta>', '  spec\t<DeploymentSpec>', '  status\t<DeploymentStatus>'],
        'deployment.spec': ['KIND:       Deployment', 'VERSION:    apps/v1', '', 'FIELD: spec <DeploymentSpec>', '', 'FIELDS:', '  minReadySeconds\t<integer>', '  paused\t<boolean>', '  progressDeadlineSeconds\t<integer>', '  replicas\t<integer>', '  revisionHistoryLimit\t<integer>', '  selector\t<LabelSelector> -required-', '  strategy\t<DeploymentStrategy>', '  template\t<PodTemplateSpec> -required-'],
        'service.spec': ['KIND:       Service', 'VERSION:    v1', '', 'FIELD: spec <ServiceSpec>', '', 'FIELDS:', '  clusterIP\t<string>', '  externalName\t<string>', '  ports\t<[]ServicePort>', '  selector\t<map[string]string>', '  sessionAffinity\t<string>', '  type\t<string>'],
        'service.spec.ports': ['FIELD: ports <[]ServicePort>', '', 'FIELDS:', '  name\t<string>', '  nodePort\t<integer>', '  port\t<integer> -required-', '  protocol\t<string>', '  targetPort\t<IntOrString>']
      };
      var p = path.toLowerCase().split('.');
      var k = kindOf(p[0]);
      if (!k) return ['error: the server doesn\'t have a resource type "' + p[0] + '"'];
      var keyPath = [k].concat(p.slice(1)).join('.');
      if (docs[keyPath]) return docs[keyPath];
      return ['KIND:       ' + KINDS[k].Kind, 'VERSION:    ' + KINDS[k].api, '', 'FIELD: ' + path, '', '# El simulador solo trae la documentación de los campos más usados en el curso.', '# En tu máquina: kubectl explain ' + path + (recursive ? ' --recursive' : '')];
    }

    function cmdGet(flags, ns) {
      var t = parseTargets(flags.positional);
      if (t.error) return [t.error];
      var out = [], any = false;
      var multi = t.targets.length > 1;
      t.targets.forEach(function (tg, idx) {
        var kind = tg.kind;
        var items;
        if (kind === 'node') { if (!S.cluster) return; items = S.cluster.nodes.map(function (n) { return { metadata: { name: n.name, labels: { 'kubernetes.io/hostname': n.name } } }; }); }
        else if (kind === 'endpoints') items = list('service', flags.A ? '*' : ns);
        else items = list(kind, flags.A ? '*' : ns);
        if (tg.names && tg.names.length) {
          var picked = [];
          for (var i = 0; i < tg.names.length; i++) {
            var found = items.filter(function (o) { return o.metadata.name === tg.names[i]; })[0];
            if (!found) { out.push('Error from server (NotFound): ' + KINDS[kind].aliases[KINDS[kind].aliases.length - 1] + ' "' + tg.names[i] + '" not found'); continue; }
            picked.push(found);
          }
          items = picked;
        }
        if (flags.l) items = items.filter(function (o) { return matchesLabelSelector(flags.l, o.metadata.labels); });
        if (!items.length) { if (!tg.all && !(tg.names && tg.names.length)) out.push(KINDS[kind].ns && !flags.A ? 'No resources found in ' + ns + ' namespace.' : 'No resources found'); return; }
        any = true;
        if (flags.o === 'yaml' || flags.o === 'json') {
          var dumped = items.map(function (o) { return kind === 'node' ? toYaml({ apiVersion: 'v1', kind: 'Node', metadata: o.metadata, _sim: { created: S.cluster.created } }) : toYaml(o); });
          if (flags.o === 'json') { items.forEach(function (o) { var c = deepClone(o); delete c._sim; out = out.concat(JSON.stringify(c, null, 2).split('\n')); }); return; }
          if (items.length === 1) out = out.concat(dumped[0].split('\n'));
          else { out.push('apiVersion: v1'); out.push('items:'); dumped.forEach(function (d) { d.split('\n').forEach(function (l, i) { out.push((i === 0 ? '- ' : '  ') + l); }); }); out.push('kind: List'); }
          return;
        }
        if (flags.o === 'name') { items.forEach(function (o) { out.push(KINDS[kind].res + '/' + o.metadata.name); }); return; }
        if (flags.o && flags.o !== 'wide') { out.push('error: unable to match a printer suitable for the output format "' + flags.o + '", allowed formats are: json,name,wide,yaml'); return; }
        if (multi && idx > 0) out.push('');
        var rows = viewRows(kind, items, flags);
        if (multi) rows = rows.map(function (r, i) { return i === 0 ? r : [KINDS[kind].res + '/' + r[flags.A ? 1 : 0]].concat(r.slice(flags.A ? 2 : 1)); });
        if (multi) rows[0] = rows[0].filter(function (h) { return h !== 'NAMESPACE'; });
        out = out.concat(table(rows));
      });
      if (flags.extra.watch) out.push('# (simulador) --watch no bloquea: vuelve a ejecutar el comando para ver el avance.');
      return out;
    }

    function cmdDescribe(flags, ns) {
      var t = parseTargets(flags.positional);
      if (t.error) return [t.error];
      var out = [];
      t.targets.forEach(function (tg) {
        var kind = tg.kind;
        if (kind === 'node') { S.cluster.nodes.filter(function (n) { return !tg.names.length || tg.names.indexOf(n.name) >= 0; }).forEach(function (n) { out.push('Name:               ' + n.name); out.push('Roles:              ' + (n.role === 'control-plane' ? 'control-plane' : '<none>')); out.push('Labels:             kubernetes.io/hostname=' + n.name + (n.role === 'control-plane' ? ',node-role.kubernetes.io/control-plane=,ingress-ready=true' : '')); out.push('Conditions:         Ready True (KubeletReady)'); out.push('Capacity:           cpu: 8, memory: 7.7Gi, pods: 110'); out.push('Non-terminated Pods: ' + list('pod', '*').filter(function (p) { return p._sim.node === n.name; }).length); out.push(''); }); return; }
        var items = list(kind, ns);
        if (tg.names.length) items = items.filter(function (o) { return tg.names.indexOf(o.metadata.name) >= 0; });
        if (flags.l) items = items.filter(function (o) { return matchesLabelSelector(flags.l, o.metadata.labels); });
        if (!items.length) { tg.names.length ? tg.names.forEach(function (n) { out.push('Error from server (NotFound): ' + KINDS[kind].aliases[KINDS[kind].aliases.length - 1] + ' "' + n + '" not found'); }) : out.push('No resources found in ' + ns + ' namespace.'); return; }
        items.forEach(function (o, i) { if (i) out.push(''); out = out.concat(describe(kind, o)); });
      });
      return out;
    }

    function cmdApply(flags, ns) {
      if (!flags.f.length) return ['error: must specify one of -f and -k'];
      var out = [];
      for (var i = 0; i < flags.f.length; i++) {
        var f = flags.f[i];
        if (/^https?:\/\//.test(f)) {
          if (/ingress-nginx/.test(f)) { S.installed['ingress-nginx'] = true; ensureNs('ingress-nginx'); installDeploy('ingress-nginx', 'ingress-nginx-controller', 'registry.k8s.io/ingress-nginx/controller:v1.11.3', { 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/component': 'controller' }); out = out.concat(['namespace/ingress-nginx created', 'serviceaccount/ingress-nginx created', 'configmap/ingress-nginx-controller created', 'clusterrole.rbac.authorization.k8s.io/ingress-nginx created', 'service/ingress-nginx-controller created', 'service/ingress-nginx-controller-admission created', 'deployment.apps/ingress-nginx-controller created', 'job.batch/ingress-nginx-admission-create created', 'ingressclass.networking.k8s.io/nginx created', 'validatingwebhookconfiguration.admissionregistration.k8s.io/ingress-nginx-admission created']); continue; }
          if (/metrics-server/.test(f)) { S.installed['metrics-server'] = true; installDeploy('kube-system', 'metrics-server', 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', { 'k8s-app': 'metrics-server' }); out = out.concat(['serviceaccount/metrics-server created', 'clusterrole.rbac.authorization.k8s.io/system:metrics-server created', 'service/metrics-server created', 'deployment.apps/metrics-server created', 'apiservice.apiregistration.k8s.io/v1beta1.metrics.k8s.io created']); continue; }
          if (/snippets\/(.+\.ya?ml)$/.test(f)) { f = f.match(/snippets\/(.+\.ya?ml)$/)[1]; }
          else { out.push('error: el simulador no descarga URLs arbitrarias. Solo ingress-nginx, metrics-server y los snippets del curso.'); continue; }
        }
        if (f === '-') { out.push('error: el simulador no lee de stdin. Usa un archivo: ls'); continue; }
        if (!(f in files)) { out.push('error: the path "' + f + '" does not exist'); out.push('# Archivos disponibles: ' + Object.keys(files).join(' ')); continue; }
        var r = loadDocs(files[f]);
        if (r.error) { out.push(r.error); continue; }
        if (!r.docs.length) { out.push('error: no objects passed to apply'); continue; }
        if (flags.dryRun) { r.docs.forEach(function (d) { out.push(KINDS[kindOf(d.kind) || 'pod'].res + '/' + d.metadata.name + ' created (dry run)'); }); continue; }
        for (var j = 0; j < r.docs.length; j++) {
          var res = applyDoc(r.docs[j], { ns: flags.n, file: f });
          out.push(res.error || res.line);
        }
      }
      reconcile();
      return out;
    }
    function ensureNs(n) { if (!nsExists(n)) put('namespace', newObj('namespace', n)); }
    function installDeploy(ns, name, image, labels) {
      ensureNs(ns);
      var d = newObj('deployment', name, ns, { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels: labels }, spec: { containers: [{ name: name, image: image, ports: [{ containerPort: 80 }] }] } } });
      d._sim.created = S.tick - 3;
      put('deployment', d);
      reconcile();
      list('pod', ns).forEach(function (p) { if (p._sim.created === S.tick) p._sim.created = S.tick - 3; });
    }

    function dryRunOut(obj, flags) {
      var o = deepClone(obj); delete o._sim;
      if (flags.o === 'yaml' || !flags.o) return yaml.dump(o, { noRefs: true }).replace(/\n$/, '').split('\n');
      if (flags.o === 'json') return JSON.stringify(o, null, 2).split('\n');
      return [KINDS[kindOf(o.kind)].res + '/' + o.metadata.name + ' created (dry run)'];
    }

    function cmdCreate(flags, ns) {
      if (flags.f.length) return cmdApply(flags, ns).map(function (l) { return l.replace(/ (configured|unchanged)$/, ' already exists'); });
      var what = flags.positional[0], name = flags.positional[1];
      if (!what) return ['error: You must specify the type of resource to create. Use "kubectl api-resources" for a complete list of supported resources.'];
      var kind = kindOf(what);
      if (!name) return ['error: NAME is required'];
      if (kind === 'namespace') { var nsObj = newObj('namespace', name); if (flags.dryRun) return dryRunOut(nsObj, flags); if (nsExists(name)) return ['Error from server (AlreadyExists): namespaces "' + name + '" already exists']; put('namespace', nsObj); return ['namespace/' + name + ' created']; }
      if (!KINDS[kind || ''] || !KINDS[kind].ns) return ['error: el simulador crea: namespace, deployment, configmap, secret generic, service clusterip|nodeport'];
      if (!nsExists(ns)) return ['Error from server (NotFound): namespaces "' + ns + '" not found'];
      var obj;
      if (kind === 'deployment') {
        var img = flags.extra.image; if (!img) return ['error: required flag(s) "image" not set'];
        var reps = parseInt(flags.extra.replicas || '1', 10);
        var c = { name: img.split('/').pop().split(':')[0].split('@')[0], image: img };
        if (flags.extra.port) c.ports = [{ containerPort: parseInt(flags.extra.port, 10) }];
        if (flags.passthrough) c.command = flags.passthrough;
        obj = newObj('deployment', name, ns, { replicas: reps, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [c] } } });
        obj.metadata.labels = { app: name };
      } else if (kind === 'configmap') {
        obj = newObj('configmap', name, ns); obj.data = {};
        String(flags.extra['from-literal'] || '').split(',').filter(Boolean).forEach(function (kv) { var i = kv.indexOf('='); obj.data[kv.slice(0, i)] = kv.slice(i + 1); });
        if (flags.extra['from-file']) { var ff = String(flags.extra['from-file']); var fname = ff.indexOf('=') >= 0 ? ff.split('=')[1] : ff; var keyName = ff.indexOf('=') >= 0 ? ff.split('=')[0] : fname.split('/').pop(); if (!(fname in files)) return ['error: error reading ' + fname + ': no such file or directory']; obj.data[keyName] = files[fname]; }
      } else if (kind === 'secret') {
        if (flags.positional[1] !== 'generic' && flags.positional[1] !== 'docker-registry' && flags.positional[1] !== 'tls') return ['error: You must specify a secret type: generic, docker-registry or tls'];
        name = flags.positional[2]; if (!name) return ['error: NAME is required'];
        obj = newObj('secret', name, ns); obj.type = 'Opaque'; obj.data = {};
        String(flags.extra['from-literal'] || '').split(',').filter(Boolean).forEach(function (kv) { var i = kv.indexOf('='); obj.data[kv.slice(0, i)] = b64(kv.slice(i + 1)); });
      } else if (kind === 'service') {
        var stype = flags.positional[1]; name = flags.positional[2]; if (!name) return ['error: NAME is required'];
        var tcp = String(flags.extra.tcp || '80:8080').split(':');
        obj = newObj('service', name, ns, { type: stype === 'nodeport' ? 'NodePort' : 'ClusterIP', selector: { app: name }, ports: [{ port: parseInt(tcp[0], 10), targetPort: parseInt(tcp[1] || tcp[0], 10), protocol: 'TCP' }] });
      } else return ['error: el simulador no implementa "kubectl create ' + what + '"'];
      if (flags.dryRun) return dryRunOut(obj, flags);
      if (get(kind, ns, name)) return ['Error from server (AlreadyExists): ' + KINDS[kind].aliases[KINDS[kind].aliases.length - 1] + ' "' + name + '" already exists'];
      if (kind === 'service') ensureClusterIP(obj);
      put(kind, obj);
      reconcile();
      return [KINDS[kind].res + '/' + name + ' created'];
    }

    function cmdRun(flags, ns) {
      var name = flags.positional[0];
      if (!name) return ['error: NAME is required for run'];
      var img = flags.extra.image; if (!img) return ['error: --image is required'];
      if (!nsExists(ns)) return ['Error from server (NotFound): namespaces "' + ns + '" not found'];
      var c = { name: name, image: img };
      if (flags.extra.port) c.ports = [{ containerPort: parseInt(flags.extra.port, 10) }];
      if (flags.passthrough) c.command = flags.passthrough;
      if (flags.extra.env) c.env = String(flags.extra.env).split(',').map(function (kv) { var i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1) }; });
      var labels = { run: name };
      if (flags.extra.labels) { labels = {}; String(flags.extra.labels).split(',').forEach(function (kv) { var i = kv.indexOf('='); labels[kv.slice(0, i)] = kv.slice(i + 1); }); }
      var pod = newObj('pod', name, ns, { containers: [c], restartPolicy: flags.extra.restart || 'Always' });
      pod.metadata.labels = labels;
      if (flags.dryRun) return dryRunOut(pod, flags);
      if (flags.extra.interactive && flags.passthrough) {
        // ejecución efímera: simula el resultado del comando
        if (!imageAvailable(img)) return ['error: la imagen ' + img + ' no está disponible en el clúster.'];
        var out = simulateInsidePod(flags.passthrough.join(' '), ns);
        return out.concat(['pod "' + name + '" deleted']);
      }
      if (get('pod', ns, name)) return ['Error from server (AlreadyExists): pods "' + name + '" already exists'];
      placePod(pod);
      put('pod', pod);
      var lines = ['pod/' + name + ' created'];
      if (flags.extra.expose) {
        var svc = newObj('service', name, ns, { type: 'ClusterIP', selector: labels, ports: [{ port: parseInt(flags.extra.port || '80', 10), targetPort: parseInt(flags.extra.port || '80', 10), protocol: 'TCP' }] });
        ensureClusterIP(svc); put('service', svc); lines.push('service/' + name + ' created');
      }
      return lines;
    }

    // wget/curl desde un pod efímero hacia un Service por DNS
    function simulateInsidePod(cmd, ns) {
      var m = cmd.match(/(?:wget|curl)\s+(?:-\S+\s+)*(?:https?:\/\/)?([a-zA-Z0-9.-]+)(?::(\d+))?(\/\S*)?/);
      if (!m) return ['# (simulador) el pod efímero ejecutó: ' + cmd];
      var host = m[1].split('.')[0];
      var svcNs = m[1].split('.')[1] || ns;
      var svc = get('service', svcNs, host);
      if (!svc) return ['wget: bad address \'' + m[1] + '\'', '# No existe el Service "' + host + '" en el namespace ' + svcNs + '.'];
      var eps = serviceEndpoints(svc);
      if (!eps.length) return ['wget: can\'t connect to remote host (' + svc.spec.clusterIP + '): Connection refused', '# El Service existe pero no tiene endpoints: kubectl describe svc ' + host + ' -n ' + svcNs];
      return httpResponse(m[3] || '/', ns, svc, false);
    }

    function httpResponse(path, ns, svc, withHeaders) {
      var saludo = 'Hola desde el default';
      if (svc) { var pods = list('pod', svc.metadata.namespace).filter(function (p) { return selectorMatches(svc.spec.selector, p.metadata.labels); }); if (pods[0]) { var e = resolveEnv(pods[0], pods[0].spec.containers[0]); if (e.APP_SALUDO) saludo = e.APP_SALUDO; } }
      var body, code = 200;
      if (/^\/actuator\/health\/(liveness|readiness)/.test(path)) body = '{"status":"UP"}';
      else if (/^\/actuator\/health/.test(path)) body = '{"status":"UP","components":{"diskSpace":{"status":"UP"},"livenessState":{"status":"UP"},"ping":{"status":"UP"},"readinessState":{"status":"UP"}}}';
      else if (/^\/actuator\/info/.test(path)) body = '{"app":{"name":"catalogo","version":"1.0.0"}}';
      else if (/^\/actuator\/prometheus/.test(path)) body = '# HELP jvm_memory_used_bytes The amount of used memory\njvm_memory_used_bytes{area="heap",id="G1 Eden Space",} 2.5165824E7';
      else if (path === '/' || /^\/saludo/.test(path)) body = saludo;
      else { code = 404; body = '{"timestamp":"now","status":404,"error":"Not Found","path":"' + path + '"}'; }
      var out = [];
      if (withHeaders) { out.push('HTTP/1.1 ' + code + (code === 200 ? ' ' : ' Not Found')); out.push('Content-Type: ' + (body[0] === '{' ? 'application/json' : 'text/plain;charset=UTF-8')); out.push('Content-Length: ' + body.length); out.push(''); }
      return out.concat(body.split('\n'));
    }

    function cmdExpose(flags, ns) {
      var t = parseTargets(flags.positional);
      if (t.error) return [t.error];
      var tg = t.targets[0];
      var src = get(tg.kind, ns, tg.names[0]);
      if (!src) return ['Error from server (NotFound): ' + KINDS[tg.kind].aliases[KINDS[tg.kind].aliases.length - 1] + ' "' + tg.names[0] + '" not found'];
      var selector = tg.kind === 'pod' ? src.metadata.labels : (src.spec.selector.matchLabels || src.spec.selector);
      var port = parseInt(flags.extra.port || '80', 10);
      var tp = flags.extra['target-port'] ? (/^\d+$/.test(flags.extra['target-port']) ? parseInt(flags.extra['target-port'], 10) : flags.extra['target-port']) : port;
      var name = flags.extra.name || src.metadata.name;
      var svc = newObj('service', name, ns, { type: flags.extra.type || 'ClusterIP', selector: selector, ports: [{ port: port, targetPort: tp, protocol: 'TCP' }] });
      svc.metadata.labels = Object.assign({}, src.metadata.labels);
      if (flags.dryRun) return dryRunOut(svc, flags);
      if (get('service', ns, name)) return ['Error from server (AlreadyExists): services "' + name + '" already exists'];
      ensureClusterIP(svc);
      put('service', svc);
      return ['service/' + name + ' exposed'];
    }

    function cmdDelete(flags, ns) {
      var out = [];
      if (flags.f.length) {
        flags.f.forEach(function (f) {
          if (!(f in files)) { out.push('error: the path "' + f + '" does not exist'); return; }
          var r = loadDocs(files[f]); if (r.error) { out.push(r.error); return; }
          r.docs.forEach(function (d) { var k = kindOf(d.kind); if (!k) return; var dns = KINDS[k].ns ? (flags.n || d.metadata.namespace || S.ns) : undefined; if (get(k, dns, d.metadata.name)) { deleteObj(k, dns, d.metadata.name); out.push(KINDS[k].res.split('.')[0] + ' "' + d.metadata.name + '" deleted'); } else out.push('Error from server (NotFound): ' + KINDS[k].aliases[KINDS[k].aliases.length - 1] + ' "' + d.metadata.name + '" not found'); });
        });
        reconcile();
        return out;
      }
      var t = parseTargets(flags.positional);
      if (t.error) return [t.error];
      t.targets.forEach(function (tg) {
        var k = tg.kind;
        var items;
        if (flags.extra.all || flags.l) { items = list(k, ns); if (flags.l) items = items.filter(function (o) { return matchesLabelSelector(flags.l, o.metadata.labels); }); }
        else {
          if (!tg.names.length) { out.push('error: resource(s) were provided, but no name was specified'); return; }
          items = [];
          tg.names.forEach(function (n) { var o = get(k, ns, n); if (o) items.push(o); else out.push('Error from server (NotFound): ' + KINDS[k].aliases[KINDS[k].aliases.length - 1] + ' "' + n + '" not found'); });
        }
        items.forEach(function (o) { deleteObj(k, o.metadata.namespace, o.metadata.name); out.push(KINDS[k].res.split('.')[0] + ' "' + o.metadata.name + '" deleted'); });
      });
      reconcile();
      return out;
    }
    function deleteObj(k, ns, name) {
      if (k === 'namespace') { for (var kk in KINDS) if (KINDS[kk].ns) list(kk, name).forEach(function (o) { del(kk, name, o.metadata.name); }); del('namespace', undefined, name); S.ns === name && (S.ns = 'default'); return; }
      if (k === 'deployment') { list('replicaset', ns).filter(function (r) { return r._sim.owner === name; }).forEach(function (r) { deleteObj('replicaset', ns, r.metadata.name); }); }
      if (k === 'replicaset') { list('pod', ns).filter(function (p) { return p._sim.owner === name; }).forEach(function (p) { del('pod', ns, p.metadata.name); }); }
      if (k === 'pod') { var p = get('pod', ns, name); if (p && p._sim.owner) { del('pod', ns, name); return; } }
      del(k, ns, name);
    }

    function cmdScale(flags, ns) {
      var t = parseTargets(flags.positional); if (t.error) return [t.error];
      var reps = flags.extra.replicas; if (reps == null) return ['error: required flag(s) "replicas" not set'];
      var out = [];
      t.targets.forEach(function (tg) { tg.names.forEach(function (n) { var o = get(tg.kind, ns, n); if (!o) { out.push('Error from server (NotFound): ' + KINDS[tg.kind].aliases[KINDS[tg.kind].aliases.length - 1] + ' "' + n + '" not found'); return; } o.spec.replicas = parseInt(reps, 10); out.push(KINDS[tg.kind].res + '/' + n + ' scaled'); }); });
      reconcile();
      return out;
    }

    function cmdSet(flags, ns) {
      var what = flags.positional[0];
      var t = parseTargets(flags.positional.slice(1, what === 'image' ? 2 : flags.positional.length));
      if (t.error) return [t.error];
      var out = [];
      t.targets.forEach(function (tg) {
        tg.names.forEach(function (n) {
          var o = get(tg.kind, ns, n);
          if (!o) { out.push('Error from server (NotFound): ' + KINDS[tg.kind].aliases[KINDS[tg.kind].aliases.length - 1] + ' "' + n + '" not found'); return; }
          var cs = tg.kind === 'pod' ? o.spec.containers : o.spec.template.spec.containers;
          if (what === 'image') {
            flags.positional.slice(2).forEach(function (pair) {
              var i = pair.indexOf('='); var cname = pair.slice(0, i), img = pair.slice(i + 1);
              var hit = false;
              cs.forEach(function (c) { if (cname === '*' || c.name === cname) { c.image = img; hit = true; } });
              if (!hit) { out.push('error: unable to find container named "' + cname + '"'); return; }
              out.push(KINDS[tg.kind].res + '/' + n + ' image updated');
            });
          } else if (what === 'resources') {
            cs.forEach(function (c) {
              c.resources = c.resources || {};
              ['limits', 'requests'].forEach(function (kind2) { if (flags.extra[kind2]) { c.resources[kind2] = c.resources[kind2] || {}; String(flags.extra[kind2]).split(',').forEach(function (kv) { var i = kv.indexOf('='); c.resources[kind2][kv.slice(0, i)] = kv.slice(i + 1); }); } });
            });
            out.push(KINDS[tg.kind].res + '/' + n + ' resource requirements updated');
          } else if (what === 'env') {
            cs.forEach(function (c) {
              if (flags.extra.from) { var ref = String(flags.extra.from).split('/'); c.envFrom = (c.envFrom || []).filter(function (e) { return !(e.configMapRef && ref[0] === 'configmap' && e.configMapRef.name === ref[1]) && !(e.secretRef && ref[0] === 'secret' && e.secretRef.name === ref[1]); }); c.envFrom.push(ref[0] === 'secret' ? { secretRef: { name: ref[1] } } : { configMapRef: { name: ref[1] } }); }
              flags.positional.slice(2).forEach(function (kv) { var i = kv.indexOf('='); if (i < 0) return; c.env = (c.env || []).filter(function (e) { return e.name !== kv.slice(0, i); }); if (!/-$/.test(kv)) c.env.push({ name: kv.slice(0, i), value: kv.slice(i + 1) }); });
            });
            out.push(KINDS[tg.kind].res + '/' + n + ' env updated');
          } else out.push('error: "kubectl set ' + what + '" no está implementado (image, resources, env).');
          if (tg.kind === 'pod') placePod(o);
        });
      });
      reconcile();
      return out;
    }

    function cmdRollout(flags, ns) {
      var action = flags.positional[0];
      var t = parseTargets(flags.positional.slice(1)); if (t.error) return [t.error];
      var out = [];
      t.targets.forEach(function (tg) {
        if (tg.kind !== 'deployment') { out.push('error: no kind "' + KINDS[tg.kind].Kind + '" is registered for rollout'); return; }
        tg.names.forEach(function (n) {
          var d = get('deployment', ns, n);
          if (!d) { out.push('Error from server (NotFound): deployments.apps "' + n + '" not found'); return; }
          var st = deployStatus(d);
          if (action === 'status') { if (st.ready >= st.desired) out.push('deployment "' + n + '" successfully rolled out'); else { out.push('Waiting for deployment "' + n + '" rollout to finish: ' + st.ready + ' of ' + st.desired + ' updated replicas are available...'); out.push('# (simulador) vuelve a ejecutar el comando; cada comando avanza el reloj.'); } }
          else if (action === 'restart') { d.spec.template.metadata.annotations = Object.assign({}, d.spec.template.metadata.annotations, { 'kubectl.kubernetes.io/restartedAt': 'tick-' + S.tick }); out.push('deployment.apps/' + n + ' restarted'); }
          else if (action === 'history') { out.push('deployment.apps/' + n); out.push('REVISION  CHANGE-CAUSE'); list('replicaset', ns).filter(function (r) { return r._sim.owner === n; }).sort(function (a, b) { return a._sim.revision - b._sim.revision; }).forEach(function (r) { out.push(pad(r._sim.revision, 10) + '<none>'); }); }
          else if (action === 'undo') { var rss = list('replicaset', ns).filter(function (r) { return r._sim.owner === n; }).sort(function (a, b) { return b._sim.revision - a._sim.revision; }); if (rss.length < 2) { out.push('error: no rollout history found for deployment "' + n + '"'); return; } d.spec.template = deepClone(rss[1].spec.template); out.push('deployment.apps/' + n + ' rolled back'); }
          else if (action === 'pause' || action === 'resume') out.push('deployment.apps/' + n + ' ' + action + 'd');
          else out.push('error: unknown command "' + action + '" for "kubectl rollout"');
        });
      });
      reconcile();
      return out;
    }

    function cmdLogs(flags, ns) {
      var name = flags.positional[0];
      var pod;
      if (flags.l) { pod = list('pod', ns).filter(function (p) { return matchesLabelSelector(flags.l, p.metadata.labels); })[0]; if (!pod) return ['No resources found in ' + ns + ' namespace.']; }
      else {
        if (!name) return ['error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.'];
        if (name.indexOf('/') >= 0) { var parts = name.split('/'); var k = kindOf(parts[0]); if (k === 'deployment') { var d = get('deployment', ns, parts[1]); if (!d) return ['Error from server (NotFound): deployments.apps "' + parts[1] + '" not found']; pod = deployStatus(d).pods[0]; if (!pod) return ['error: no pods for deployment ' + parts[1]]; } else pod = get('pod', ns, parts[1]); }
        else pod = get('pod', ns, name);
        if (!pod) return ['Error from server (NotFound): pods "' + name + '" not found'];
      }
      var r = logsFor(pod, flags.c, ns);
      if (r.error) return [r.error];
      var lines = flags.extra.tail ? r.lines.slice(-parseInt(flags.extra.tail, 10)) : r.lines;
      if (flags.extra.follow || flags.extra.f) lines = lines.concat(['# (simulador) -f no bloquea.']);
      return lines;
    }

    function cmdExec(flags, ns) {
      var name = flags.positional[0];
      if (!name) return ['error: expected \'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]\'.'];
      var pod;
      if (name.indexOf('/') >= 0) {
        var tk = kindOf(name.split('/')[0]), tn = name.split('/')[1];
        if (tk === 'deployment') { var dd = get('deployment', ns, tn); if (!dd) return ['Error from server (NotFound): deployments.apps "' + tn + '" not found']; pod = deployStatus(dd).pods[0]; if (!pod) return ['error: no pods found for deployment ' + tn]; }
        else if (tk === 'service') { var ss = get('service', ns, tn); if (!ss) return ['Error from server (NotFound): services "' + tn + '" not found']; pod = list('pod', ns).filter(function (p) { return selectorMatches(ss.spec.selector, p.metadata.labels); })[0]; if (!pod) return ['error: no pods found for service ' + tn]; }
        else pod = get('pod', ns, tn);
        name = pod ? pod.metadata.name : tn;
      } else pod = get('pod', ns, name);
      if (!pod) return ['Error from server (NotFound): pods "' + name + '" not found'];
      var v = podView(pod);
      if (v.status !== 'Running') return ['error: unable to upgrade connection: container not found ("' + pod.spec.containers[0].name + '")', '# El Pod está en ' + v.status + '.'];
      var c = flags.c ? pod.spec.containers.filter(function (x) { return x.name === flags.c; })[0] : pod.spec.containers[0];
      if (!c) return ['error: container ' + flags.c + ' not found in pod ' + name];
      var cmd = (flags.passthrough || []).join(' ');
      if (!cmd) return ['error: you must specify at least one command for the container'];
      if (/^(env|printenv)\b/.test(cmd)) { var env = resolveEnv(pod, c); var keys = Object.keys(env); var base = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOSTNAME=' + name, 'KUBERNETES_SERVICE_HOST=10.96.0.1', 'KUBERNETES_SERVICE_PORT=443', 'JAVA_HOME=/opt/java/openjdk']; return base.concat(keys.map(function (k) { return k + '=' + env[k]; })); }
      if (/^(sh|bash)\s+-c\s+/.test(cmd)) cmd = cmd.replace(/^(sh|bash)\s+-c\s+/, '');
      if (/^(cat|tail)\b.*catalogo\.log/.test(cmd)) return ['INFO  g.e.u.c.CatalogoApplication : Started CatalogoApplication in 4.218 seconds', 'INFO  g.e.u.c.SaludoController    : GET /actuator/health -> 200'];
      if (/^ls\b/.test(cmd)) return ['application.jar  BOOT-INF  META-INF  org'];
      if (/^(hostname)\b/.test(cmd)) return [name];
      if (/^(wget|curl)\b/.test(cmd)) { if (/localhost|127\.0\.0\.1/.test(cmd)) { var pm = cmd.match(/(\/\S*)\s*$/); return httpResponse(pm ? pm[1].replace(/^.*:\d+/, '') : '/', ns, null, false); } return simulateInsidePod(cmd, ns); }
      if (/^(sh|bash)$/.test(cmd)) return ['# (simulador) no hay shell interactiva. Pasa el comando directo: kubectl exec ' + name + ' -- env'];
      return ['# (simulador) "' + cmd + '" ejecutado dentro de ' + name + ' (sin salida simulada).'];
    }

    function cmdPatch(flags, ns) {
      var t = parseTargets(flags.positional); if (t.error) return [t.error];
      var patch = flags.extra.patch; if (!patch) return ['error: Must specify -p to patch'];
      var out = [];
      t.targets.forEach(function (tg) {
        tg.names.forEach(function (n) {
          var o = get(tg.kind, ns, n);
          if (!o) { out.push('Error from server (NotFound): ' + KINDS[tg.kind].aliases[KINDS[tg.kind].aliases.length - 1] + ' "' + n + '" not found'); return; }
          var p;
          try { p = /^\s*[\[{]/.test(patch) ? JSON.parse(patch) : yaml.load(patch); } catch (e) { out.push('error: unable to parse "' + patch + '": ' + e.message); return; }
          if (flags.extra.type === 'json') {
            if (!Array.isArray(p)) { out.push('error: json patch debe ser una lista de operaciones'); return; }
            p.forEach(function (op) { var path = op.path.split('/').slice(1); var cur = o; for (var i = 0; i < path.length - 1; i++) { var seg = /^\d+$/.test(path[i]) ? parseInt(path[i], 10) : path[i]; cur = cur[seg]; if (cur == null) return; } var last = /^\d+$/.test(path[path.length - 1]) ? parseInt(path[path.length - 1], 10) : path[path.length - 1]; if (op.op === 'remove') { Array.isArray(cur) ? cur.splice(last, 1) : delete cur[last]; } else if (last === '-' && Array.isArray(cur)) cur.push(op.value); else cur[last] = op.value; });
          } else {
            var sim = o._sim; deepMerge(o, p); o._sim = sim;
          }
          if (tg.kind === 'service') ensureClusterIP(o);
          out.push(KINDS[tg.kind].res + '/' + n + ' patched');
        });
      });
      reconcile();
      return out;
    }

    function cmdLabel(flags, ns, sub) {
      var t = parseTargets(flags.positional.slice(0, 2)); if (t.error) return [t.error];
      var kvs = flags.positional.slice(2);
      var out = [];
      t.targets.forEach(function (tg) { tg.names.forEach(function (n) { var o = get(tg.kind, ns, n); if (!o) { out.push('Error from server (NotFound): ' + KINDS[tg.kind].aliases[KINDS[tg.kind].aliases.length - 1] + ' "' + n + '" not found'); return; } var target = sub === 'label' ? (o.metadata.labels = o.metadata.labels || {}) : (o.metadata.annotations = o.metadata.annotations || {}); kvs.forEach(function (kv) { if (/-$/.test(kv)) delete target[kv.slice(0, -1)]; else { var i = kv.indexOf('='); if (target[kv.slice(0, i)] != null && !flags.extra.overwrite && sub === 'label') { out.push('error: \'' + kv.slice(0, i) + '\' already has a value (' + target[kv.slice(0, i)] + '), and --overwrite is false'); return; } target[kv.slice(0, i)] = kv.slice(i + 1); } }); out.push(KINDS[tg.kind].res + '/' + n + ' ' + (sub === 'label' ? 'labeled' : 'annotated')); }); });
      return out;
    }

    function cmdPortForward(flags, ns) {
      var target = flags.positional[0], ports = flags.positional[1];
      if (!target || !ports) return ['error: TYPE/NAME and list of ports are required for port-forward'];
      var kind = 'pod', name = target;
      if (target.indexOf('/') >= 0) { kind = kindOf(target.split('/')[0]); name = target.split('/')[1]; }
      var o = get(kind, ns, name);
      if (!o) return ['Error from server (NotFound): ' + KINDS[kind].aliases[KINDS[kind].aliases.length - 1] + ' "' + name + '" not found'];
      var local = ports.split(':')[0];
      if (S.dockerRun && String(S.dockerRun.port) === String(local)) return ['Unable to listen on port ' + local + ': Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:' + local + ': bind: address already in use]', 'error: unable to listen on any of the requested ports: [{' + local + ' ' + (ports.split(':')[1] || local) + '}]', '# El contenedor de docker run sigue ocupando el puerto. Detenlo con: docker ps && docker stop <id>  (o usa otro puerto local: ' + (parseInt(local, 10) + 1) + ':' + (ports.split(':')[1] || local) + ')'];
      S.portForward = { ns: ns, kind: kind, name: name, local: local };
      return ['Forwarding from 127.0.0.1:' + local + ' -> ' + (ports.split(':')[1] || local), 'Forwarding from [::1]:' + local + ' -> ' + (ports.split(':')[1] || local), '# (simulador) el port-forward queda activo en segundo plano. Prueba: curl localhost:' + local + '/actuator/health'];
    }

    function cmdTop(flags, ns) {
      var what = flags.positional[0];
      if (kindOf(what) === 'node') return table([['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%']].concat(S.cluster.nodes.map(function (n, i) { return [n.name, (120 + i * 37) + 'm', (3 + i) + '%', (900 + i * 210) + 'Mi', (11 + i * 2) + '%']; })));
      var pods = list('pod', flags.A ? '*' : ns).filter(function (p) { return podView(p).status === 'Running'; });
      if (!pods.length) return ['No resources found in ' + ns + ' namespace.'];
      return table([['NAME', 'CPU(cores)', 'MEMORY(bytes)']].concat(pods.map(function (p) { return [p.metadata.name, (5 + hash(p.metadata.name) % 40) + 'm', (/^catalogo/.test(p.spec.containers[0].image) ? 180 + hash(p.metadata.name) % 90 : 2 + hash(p.metadata.name) % 10) + 'Mi']; })));
    }

    // ----- kind / docker / curl -----
    function kindCmd(args) {
      var sub = args[0], sub2 = args[1];
      var opts = {};
      for (var i = 1; i < args.length; i++) { var m = args[i].match(/^--(\S+?)(?:=(.*))?$/); if (m) opts[m[1]] = m[2] != null ? m[2] : args[++i]; }
      if (!sub || sub === '--help' || sub === 'help') return ['kind creates and manages local Kubernetes clusters using Docker container \'nodes\'', '', 'Usage: kind [command]', '  create cluster [--name N] [--config F]', '  delete cluster [--name N]', '  get clusters | nodes', '  load docker-image IMAGE [--name N]', '  version'];
      if (sub === 'version') return ['kind v0.25.0 go1.22.9 windows/amd64'];
      if (sub === 'get' && sub2 === 'clusters') return S.cluster ? [S.cluster.name] : ['No kind clusters found.'];
      if (sub === 'get' && sub2 === 'nodes') return S.cluster ? S.cluster.nodes.map(function (n) { return n.name; }) : ['ERROR: no nodes found for cluster "kind"'];
      if (sub === 'create' && sub2 === 'cluster') {
        var name = opts.name || 'kind';
        if (S.cluster) return ['ERROR: failed to create cluster: node(s) already exist for a cluster with the name "' + S.cluster.name + '"', '# Bórralo primero: kind delete cluster --name ' + S.cluster.name];
        var nodes = [{ role: 'control-plane' }];
        if (opts.config) {
          if (!(opts.config in files)) return ['ERROR: failed to create cluster: open ' + opts.config + ': no such file or directory'];
          var cfg; try { cfg = yaml.load(files[opts.config]); } catch (e) { return ['ERROR: failed to create cluster: error parsing config: ' + e.message]; }
          if (cfg && cfg.nodes && cfg.nodes.length) nodes = cfg.nodes.map(function (n) { return { role: n.role || 'worker' }; });
        }
        var wi = 0;
        nodes = nodes.map(function (n) { return { role: n.role, name: n.role === 'control-plane' ? name + '-control-plane' : name + '-worker' + (++wi > 1 ? wi : '') }; });
        bootstrapCluster(name, nodes);
        S.cluster.created = S.tick;
        return ['Creating cluster "' + name + '" ...', ' ✓ Ensuring node image (kindest/node:v1.31.2) 🖼', ' ✓ Preparing nodes' + nodes.map(function () { return ' 📦'; }).join(''), ' ✓ Writing configuration 📜', ' ✓ Starting control-plane 🕹️', ' ✓ Installing CNI 🔌', ' ✓ Installing StorageClass 💾'].concat(nodes.length > 1 ? [' ✓ Joining worker nodes 🚜'] : []).concat(['Set kubectl context to "kind-' + name + '"', 'You can now use your cluster with:', '', 'kubectl cluster-info --context kind-' + name, '', 'Have a nice day! 👋']);
      }
      if (sub === 'delete' && sub2 === 'cluster') { var dn = opts.name || 'kind'; if (!S.cluster || S.cluster.name !== dn) return ['Deleting cluster "' + dn + '" ...', '# (no existía ningún clúster con ese nombre)']; S.cluster = null; S.portForward = null; for (var k in KINDS) S.objs[k] = {}; return ['Deleting cluster "' + dn + '" ...', 'Deleted nodes: ' + JSON.stringify(S.cluster ? [] : [dn + '-control-plane'])]; }
      if (sub === 'load' && sub2 === 'docker-image') {
        var img = args[2]; if (!img || img[0] === '-') return ['ERROR: a list of image names is required'];
        if (!S.cluster) return ['ERROR: no nodes found for cluster "' + (opts.name || 'kind') + '"', '# Crea el clúster primero.'];
        if (opts.name && opts.name !== S.cluster.name) return ['ERROR: no nodes found for cluster "' + opts.name + '"'];
        if (!S.images[img]) return ['ERROR: image: "' + img + '" not present locally', '# Constrúyela primero: docker build -t ' + img + ' .'];
        S.loaded[img] = true;
        return S.cluster.nodes.map(function (n) { return 'Image: "' + img + '" with ID "sha256:' + hashName(img, 12) + '" not yet present on node "' + n.name + '", loading...'; });
      }
      return ['ERROR: unknown command "' + args.join(' ') + '" for "kind"'];
    }

    function dockerCmd(args) {
      var sub = args[0];
      if (!sub || sub === '--help') return ['Usage:  docker [OPTIONS] COMMAND', '', 'Soportado en el simulador: build, images, run, ps, pull, rmi, version'];
      if (sub === 'version' || sub === '-v' || sub === '--version') return ['Docker version 27.3.1, build ce12230'];
      if (sub === 'build') {
        var tag = null, ctx = null;
        for (var i = 1; i < args.length; i++) { if (args[i] === '-t' || args[i] === '--tag') tag = args[++i]; else if (/^--tag=/.test(args[i])) tag = args[i].slice(6); else if (args[i][0] !== '-') ctx = args[i]; }
        if (!ctx) return ['ERROR: "docker buildx build" requires exactly 1 argument.', 'Usage:  docker buildx build [OPTIONS] PATH | URL | -'];
        if (!('Dockerfile' in files)) return ['ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory'];
        var img = tag || 'sha256:' + hashName('untagged' + S.tick, 12);
        if (!/:/.test(img)) img += ':latest';
        S.images[img] = true;
        var steps = files.Dockerfile.split('\n').filter(function (l) { return /^(FROM|COPY|RUN|WORKDIR|USER|EXPOSE|ENTRYPOINT)/.test(l); });
        var out = ['[+] Building 48.3s (' + (steps.length + 3) + '/' + (steps.length + 3) + ') FINISHED                                   docker:default', ' => [internal] load build definition from Dockerfile                        0.0s', ' => [internal] load metadata for docker.io/library/eclipse-temurin:21-jre   1.2s', ' => [internal] load metadata for docker.io/library/eclipse-temurin:21-jdk   1.2s'];
        steps.forEach(function (s, idx) { out.push(' => [' + (idx < 7 ? 'build ' + (idx + 1) + '/7' : 'stage-1 ' + (idx - 6) + '/' + (steps.length - 7)) + '] ' + s.slice(0, 55).replace(/\s+$/, '') + (s.length > 55 ? '…' : '') + '  ' + (/RUN .*mvnw/.test(s) ? '31.4s' : '0.' + (idx % 9) + 's')); });
        out.push(' => exporting to image                                                      1.1s');
        out.push(' => => naming to docker.io/library/' + img + '                                0.0s');
        return out;
      }
      if (sub === 'images' || (sub === 'image' && args[1] === 'ls')) { var rows = [['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE']]; Object.keys(S.images).forEach(function (im) { var p = im.split(':'); rows.push([p[0], p[1] || 'latest', hashName(im, 12), 'hace ' + ageOf(2), /catalogo/.test(im) ? '291MB' : '4.26MB']); }); return rows.length > 1 ? table(rows) : table(rows).concat(['# Aún no has construido ninguna imagen: docker build -t catalogo:1.0.0 .']); }
      if (sub === 'pull') { var pi = args[1]; if (!pi) return ['"docker pull" requires exactly 1 argument.']; if (!PUBLIC_IMAGES.test(pi)) return ['Error response from daemon: pull access denied for ' + pi.split(':')[0] + ', repository does not exist or may require \'docker login\'']; if (!/:/.test(pi)) pi += ':latest'; S.images[pi] = true; return ['Using default tag: latest', pi.split(':')[1] + ': Pulling from library/' + pi.split(':')[0], 'Digest: sha256:' + hashName(pi, 20), 'Status: Downloaded newer image for ' + pi]; }
      if (sub === 'rmi') { var ri = args[1]; if (!S.images[ri]) return ['Error response from daemon: No such image: ' + ri]; delete S.images[ri]; return ['Untagged: ' + ri]; }
      if (sub === 'run') {
        var image = null, port = null;
        for (var j = 1; j < args.length; j++) { if (args[j] === '-p' || args[j] === '--publish') port = args[++j]; else if (args[j][0] !== '-' && !image) image = args[j]; }
        if (!image) return ['"docker run" requires at least 1 argument.'];
        if (!S.images[image] && !PUBLIC_IMAGES.test(image)) return ['Unable to find image \'' + image + '\' locally', 'docker: Error response from daemon: pull access denied for ' + image.split(':')[0] + ', repository does not exist or may require \'docker login\'.', '# Constrúyela primero: docker build -t ' + image + ' .'];
        S.dockerRun = { image: image, port: port ? port.split(':')[0] : null, id: hashName('c' + S.tick, 12) };
        if (/^catalogo/.test(image)) return ['', '  .   ____          _            __ _ _', ' /\\\\ / ___\'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\', '( ( )\\___ | \'_ | \'_| | \'_ \\/ _` | \\ \\ \\ \\', ' \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )', '  \'  |____| .__|_| |_|_| |_\\__, | / / / /', ' =========|_|==============|___/=/_/_/_/', '', ' :: Spring Boot ::                (v3.3.5)', '', 'INFO 1 --- [catalogo] [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port 8080 (http) with context path \'/\'', 'INFO 1 --- [catalogo] [           main] g.e.u.c.CatalogoApplication              : Started CatalogoApplication in 3.871 seconds (process running for 4.4)', '# (simulador) el contenedor sigue corriendo en segundo plano. Prueba: curl -s localhost:' + (S.dockerRun.port || 8080) + '/actuator/health'];
        return [S.dockerRun.id + hashName('x' + S.tick, 52)];
      }
      if (sub === 'ps') { var pr = [['CONTAINER ID', 'IMAGE', 'COMMAND', 'STATUS', 'PORTS', 'NAMES']]; if (S.dockerRun) pr.push([S.dockerRun.id, S.dockerRun.image, '"java -jar applicati…"', 'Up ' + ageOf(1), S.dockerRun.port ? '0.0.0.0:' + S.dockerRun.port + '->8080/tcp' : '', 'brave_' + hashName(S.dockerRun.id, 5)]); if (S.cluster) S.cluster.nodes.forEach(function (n) { pr.push([hashName(n.name, 12), 'kindest/node:v1.31.2', '"/usr/local/bin/entr…"', 'Up ' + ageOf(S.tick - S.cluster.created), n.role === 'control-plane' ? '127.0.0.1:43627->6443/tcp, 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp' : '', n.name]); }); return table(pr); }
      if (sub === 'stop' || sub === 'kill' || sub === 'rm') { var target = args[args.length - 1]; if (S.dockerRun && (S.dockerRun.id.indexOf(target) === 0 || target === 'brave_' + hashName(S.dockerRun.id, 5))) { S.dockerRun = null; return [target]; } return ['Error response from daemon: No such container: ' + target]; }
      return ['docker: \'' + sub + '\' is not a docker command (en el simulador).'];
    }

    function curlCmd(args) {
      var url = null, headers = false, silent = false;
      for (var i = 0; i < args.length; i++) { var a = args[i]; if (a === '-i' || a === '--include') headers = true; else if (a === '-s' || a === '--silent') silent = true; else if (a === '-si' || a === '-is') { headers = true; silent = true; } else if (a === '-H' || a === '-X' || a === '-d' || a === '-o' || a === '-w') i++; else if (a[0] !== '-') url = a; }
      if (!url) return ['curl: try \'curl --help\' for more information'];
      var m = url.match(/^(?:https?:\/\/)?([^\/:]+)(?::(\d+))?(\/.*)?$/);
      if (!m) return ['curl: (3) URL using bad/illegal format'];
      var host = m[1], port = m[2] || '80', path = m[3] || '/';
      var hint = silent ? [] : [];
      if (host === 'localhost' || host === '127.0.0.1' || host === 'host.docker.internal') {
        if (S.dockerRun && String(S.dockerRun.port) === port) return httpResponse(path, S.ns, null, headers);
        if (S.portForward && String(S.portForward.local) === port) { var pf = S.portForward; var svc = pf.kind === 'service' ? get('service', pf.ns, pf.name) : null; var tgt = svc || get(pf.kind, pf.ns, pf.name); if (!tgt) { S.portForward = null; return ['curl: (7) Failed to connect to localhost port ' + port + ' after 0 ms: Connection refused', '# El recurso del port-forward ya no existe.']; } if (!svc) { var pv = podView(tgt); if (pv.status !== 'Running' || pv.ready < pv.total) return ['curl: (52) Empty reply from server', '# El Pod está en ' + pv.status + ' (' + pv.ready + '/' + pv.total + ' ready).']; } return httpResponse(path, pf.ns, svc, headers); }
        return ['curl: (7) Failed to connect to localhost port ' + port + ' after 0 ms: Connection refused', '# Nada escucha en localhost:' + port + '. Opciones: docker run --rm -p 8080:8080 catalogo:1.0.0  |  kubectl port-forward svc/catalogo 8080:80 -n softav'];
      }
      if (/\.localtest\.me$/.test(host) || host === 'localhost.localdomain') {
        if (!S.cluster) return ['curl: (7) Failed to connect to ' + host + ' port ' + port + ' after 0 ms: Connection refused'];
        if (!S.installed['ingress-nginx']) return ['curl: (7) Failed to connect to ' + host + ' port ' + port + ' after 0 ms: Connection refused', '# No hay Ingress Controller escuchando en el puerto 80. Clase 3: kubectl apply -f https://kubernetes.github.io/ingress-nginx/deploy/static/provider/kind/deploy.yaml'];
        var ing = null, rule = null, pathMatch = null;
        list('ingress', '*').forEach(function (ig) { (ig.spec.rules || []).forEach(function (r) { if (r.host === host) { (r.http && r.http.paths || []).forEach(function (pp) { if (path.indexOf(pp.path || '/') === 0 && (!pathMatch || (pp.path || '').length > (pathMatch.path || '').length)) { ing = ig; rule = r; pathMatch = pp; } }); } }); });
        if (!ing) return (headers ? ['HTTP/1.1 404 Not Found', 'Content-Type: text/html', ''] : []).concat(['<html>', '<head><title>404 Not Found</title></head>', '<body>', '<center><h1>404 Not Found</h1></center>', '<hr><center>nginx</center>', '</body>', '</html>', '# Ningún Ingress tiene una regla para el host ' + host + '.']);
        var be = pathMatch.backend && pathMatch.backend.service;
        var svc2 = be && get('service', ing.metadata.namespace, be.name);
        if (!svc2) return (headers ? ['HTTP/1.1 503 Service Temporarily Unavailable', 'Content-Type: text/html', ''] : []).concat(['<html><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>', '# El Ingress apunta al Service "' + (be ? be.name : '?') + '" que no existe en ' + ing.metadata.namespace + '.']);
        var portOk = (svc2.spec.ports || []).some(function (p) { return be.port && (p.name === be.port.name || p.port === be.port.number); });
        if (!portOk) return (headers ? ['HTTP/1.1 503 Service Temporarily Unavailable', 'Content-Type: text/html', ''] : []).concat(['<html><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>', '# El puerto del backend (' + JSON.stringify(be.port) + ') no existe en el Service ' + svc2.metadata.name + '.']);
        var eps = serviceEndpoints(svc2);
        if (!eps.length) return (headers ? ['HTTP/1.1 503 Service Temporarily Unavailable', 'Content-Type: text/html', ''] : []).concat(['<html><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>', '# El Service ' + svc2.metadata.name + ' no tiene endpoints: kubectl describe svc ' + svc2.metadata.name + ' -n ' + svc2.metadata.namespace]);
        return httpResponse(path, ing.metadata.namespace, svc2, headers);
      }
      if (/^(\d+\.){3}\d+$/.test(host)) { var hit = list('service', '*').filter(function (s) { return s.spec.clusterIP === host; })[0]; if (hit) return ['curl: (28) Connection timed out', '# Las ClusterIP (' + host + ') solo son alcanzables desde dentro del clúster. Usa: kubectl run tmp --rm -it --image=busybox:1.36 -- wget -qO- http://' + hit.metadata.name + path]; }
      if (/^(start\.spring\.io|github\.com|kubernetes\.io|raw\.githubusercontent\.com)$/.test(host)) return ['# (simulador) sin acceso a internet. Abre ' + url + ' en tu navegador.'];
      return ['curl: (6) Could not resolve host: ' + host].concat(hint);
    }

    // ----- shell -----
    function expandEnv(tok) {
      return tok.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, function (m, name) { return S.env[name] != null ? S.env[name] : (name === 'HOME' ? '/home/student' : name === 'USER' ? 'student' : ''); });
    }

    function runSimple(tokens) {
      if (!tokens.length) return [];
      // alias
      var seen = 0;
      while (S.aliases[tokens[0]] && seen++ < 5) { var t = tokenize(S.aliases[tokens[0]]); tokens = (t.tokens || []).concat(tokens.slice(1)); }
      // expansión de variables (después del alias, como bash)
      var expanded = [];
      tokens.forEach(function (tok) { var e = expandEnv(tok); if (e !== tok && /\s/.test(e)) { var tt = tokenize(e); expanded = expanded.concat(tt.tokens || [e]); } else expanded.push(e); });
      tokens = expanded;
      var cmd = tokens[0], args = tokens.slice(1);
      switch (cmd) {
        case 'kubectl': return kubectl(args);
        case 'kind': return kindCmd(args);
        case 'docker': return dockerCmd(args);
        case 'curl': return curlCmd(args);
        case 'wget': return curlCmd(args.filter(function (a) { return a !== '-qO-' && a !== '-q' && a !== '-O-'; }));
        case 'help': case '?': return helpText();
        case 'tutorial': return tutorialText();
        case 'clear': return ['\u001bc'];
        case 'reset': reset(); return ['# Estado reiniciado: sin clúster, sin imágenes, archivos originales.'];
        case 'ls': return [Object.keys(files).sort().join('  ')];
        case 'cat': { if (!args.length) return ['cat: falta el archivo']; var o = []; args.forEach(function (f) { if (f in files) o = o.concat(files[f].split('\n')); else o.push('cat: ' + f + ': No such file or directory'); }); return o; }
        case 'head': case 'tail': { var n = 10, f2 = null; for (var i = 0; i < args.length; i++) { if (args[i] === '-n') n = parseInt(args[++i], 10); else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1), 10); else f2 = args[i]; } if (!f2 || !(f2 in files)) return [cmd + ': ' + (f2 || '') + ': No such file or directory']; var ls = files[f2].split('\n'); return cmd === 'head' ? ls.slice(0, n) : ls.slice(-n); }
        case 'grep': { var pat = args.filter(function (a) { return a[0] !== '-'; })[0]; var fl = args.filter(function (a) { return a[0] !== '-'; }).slice(1); var inv = args.indexOf('-v') >= 0, ci = args.indexOf('-i') >= 0; if (!fl.length) return ['grep: en el simulador úsalo con un archivo o con una tubería: kubectl get pods | grep Running']; var re = new RegExp(pat, ci ? 'i' : ''); var go = []; fl.forEach(function (f) { if (!(f in files)) { go.push('grep: ' + f + ': No such file or directory'); return; } files[f].split('\n').forEach(function (l) { if (re.test(l) !== inv) go.push((fl.length > 1 ? f + ':' : '') + l); }); }); return go; }
        case 'sed': return sedCmd(args);
        case 'echo': return [args.join(' ')];
        case 'pwd': return ['/home/student/softav'];
        case 'whoami': return ['student'];
        case 'date': return [new Date().toString()];
        case 'sleep': { var s = parseFloat(args[0]) || 1; S.tick += Math.max(1, Math.round(s / 5)); return []; }
        case 'history': return S.history.map(function (h, i) { return pad(i + 1, 5) + h; });
        case 'alias': { if (!args.length) return Object.keys(S.aliases).map(function (k) { return 'alias ' + k + "='" + S.aliases[k] + "'"; }); args.forEach(function (a) { var i = a.indexOf('='); if (i < 0) return; S.aliases[a.slice(0, i)] = a.slice(i + 1); }); return []; }
        case 'unalias': args.forEach(function (a) { delete S.aliases[a]; }); return [];
        case 'export': { args.forEach(function (a) { var i = a.indexOf('='); if (i < 0) return; S.env[a.slice(0, i)] = a.slice(i + 1); }); return []; }
        case 'env': case 'printenv': return Object.keys(S.env).map(function (k) { return k + '=' + S.env[k]; });
        case 'source': case '.': return ['# (simulador) no hay archivos de shell que cargar.'];
        case 'vi': case 'vim': case 'nano': case 'code': return ['# No hay editor en el simulador. Edita con sed: sed -i \'s/viejo/nuevo/\' ' + (args[0] || 'archivo.yaml'), '# o copia el archivo con: cat ' + (args[0] || 'archivo.yaml')];
        case 'helm': return ['# helm no está en el simulador. En el curso instalamos todo con kubectl apply -f.'];
        case 'k9s': case 'minikube': case 'k3d': return ['# ' + cmd + ' no está en el simulador; aquí usamos kind + kubectl.'];
        case 'mvn': case './mvnw': return ['[INFO] Scanning for projects...', '[INFO] Building catalogo 1.0.0', '[INFO] --- spring-boot:3.3.5:repackage (repackage) @ catalogo ---', '[INFO] BUILD SUCCESS', '[INFO] Total time:  21.4 s'];
        case 'java': return ['openjdk 21.0.5 2024-10-15 LTS'];
        case 'exit': case 'logout': return ['# Esto es una pestaña del navegador; ciérrala cuando quieras 🙂'];
        case 'sudo': return ['student is not in the sudoers file.  This incident will be reported.'];
        default:
          if (cmd[0] === '$' || cmd === '') return [];
          return ['bash: ' + cmd + ': command not found', '# Escribe help para ver qué hay disponible.'];
      }
    }

    function sedCmd(args) {
      var inplace = false, expr = null, file = null;
      for (var i = 0; i < args.length; i++) { if (args[i] === '-i' || /^-i/.test(args[i])) inplace = true; else if (args[i] === '-e') expr = args[++i]; else if (!expr) expr = args[i]; else file = args[i]; }
      if (!expr) return ['sed: falta la expresión. Ejemplo: sed -i \'s/catalogo-bf-cfg/catalogo-bf-config/\' break-fix-01.yaml'];
      if (!file) return ['sed: en el simulador indica el archivo: sed -i \'' + expr + '\' archivo.yaml'];
      if (!(file in files)) return ['sed: can\'t read ' + file + ': No such file or directory'];
      var delim = expr[1];
      if (expr[0] !== 's' || !delim) return ['sed: solo se soporta s/patrón/reemplazo/[g]'];
      var parts = [], cur = '';
      for (var j = 2; j < expr.length; j++) { if (expr[j] === '\\' && expr[j + 1] === delim) { cur += delim; j++; } else if (expr[j] === delim) { parts.push(cur); cur = ''; } else cur += expr[j]; }
      parts.push(cur);
      if (parts.length < 2) return ['sed: -e expression #1, char ' + expr.length + ': unterminated `s\' command'];
      var flagsS = parts[2] || '';
      var re; try { re = new RegExp(parts[0], flagsS.indexOf('g') >= 0 ? 'g' : ''); } catch (e) { return ['sed: expresión inválida: ' + e.message]; }
      var repl = parts[1].replace(/\\(\d)/g, '$$$1');
      var lines = files[file].split('\n').map(function (l) { return l.replace(re, repl); });
      var changed = lines.join('\n') !== files[file];
      if (inplace) { files[file] = lines.join('\n'); return changed ? ['# ' + file + ' modificado. Aplica el cambio con: kubectl apply -f ' + file] : ['# sed no encontró coincidencias en ' + file]; }
      return lines;
    }

    function helpText() {
      return [
        'Consola del curso 0780 Software Avanzado: un simulador de kubectl, kind y docker en el navegador.',
        'No hay un clúster real; el estado vive en memoria (se pierde al recargar). Cada comando avanza el reloj.',
        '',
        'Comandos:    kubectl, kind, docker, curl, sed, cat, ls, grep, alias, export, clear, reset, tutorial',
        'Archivos:    ' + Object.keys(files).sort().join(', '),
        'Atajos:      Tab completa comandos y archivos · ↑/↓ historial · Ctrl+L limpia · Ctrl+C cancela',
        '',
        'Lo que sí funciona: get/describe/apply/create/run/expose/delete/scale/set/rollout/logs/exec/patch/port-forward,',
        '  -n -A -o wide|yaml|json|name -l --show-labels --dry-run=client, tuberías con | grep y | wc -l, && y ;',
        'Lo que no: editores (usa sed -i), --watch bloqueante, internet.',
        '',
        'Escribe "tutorial" para ver el flujo completo de las clases 1 a 5.'
      ];
    }
    function tutorialText() {
      return [
        '# Clase 1 · imagen y clúster',
        'docker build -t catalogo:1.0.0 .',
        'docker run --rm -p 8080:8080 catalogo:1.0.0 && curl -s localhost:8080/actuator/health',
        'kind create cluster --name softav --config kind-config.yaml',
        'kind load docker-image catalogo:1.0.0 --name softav',
        'alias k=kubectl && export do="--dry-run=client -o yaml"',
        '# Clase 2 · Deployments',
        'k apply -f namespace.yaml && k config set-context --current --namespace=softav',
        'k apply -f configmap.yaml && k apply -f deployment.yaml',
        'k get deploy,rs,pods -o wide',
        'k create deployment demo --image=nginx:1.27 --replicas=3 $do',
        '# Clase 3 · Services e Ingress',
        'k apply -f service.yaml && k get svc,endpoints',
        'k apply -f https://kubernetes.github.io/ingress-nginx/deploy/static/provider/kind/deploy.yaml',
        'k apply -f ingress.yaml && curl -i http://catalogo.localtest.me/actuator/health',
        '# Clase 4 · probes, recursos, HPA y break-fix',
        'k apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml',
        'k apply -f hpa.yaml && k get hpa && k top pods',
        'k apply -f break-fix-01.yaml && k get pods -l app=catalogo-bf',
        'k describe pod -l app=catalogo-bf   # lee los Events y arregla con sed -i + kubectl apply',
        '# Clase 5 · patrones',
        'k run postgres --image=postgres:16 --port=5432 --expose',
        'k apply -f patrones-sidecar.yaml && k get pod catalogo-patrones && k logs catalogo-patrones -c espera-db'
      ];
    }

    // Ejecuta una línea completa (con | && ;) y devuelve las líneas de salida.
    function run(line) {
      line = String(line);
      if (line.trim()) S.history.push(line);
      var t = tokenize(line);
      if (t.error) return [t.error];
      var tokens = t.tokens;
      if (!tokens.length) return [];
      // separar por ; y &&
      var groups = [[]], ops = [];
      tokens.forEach(function (tok) { if (tok === ';' || tok === '&&') { ops.push(tok); groups.push([]); } else groups[groups.length - 1].push(tok); });
      var out = [];
      var lastOk = true;
      for (var g = 0; g < groups.length; g++) {
        if (g > 0 && ops[g - 1] === '&&' && !lastOk) continue;
        var pipeline = [[]];
        groups[g].forEach(function (tok) { if (tok === '|') pipeline.push([]); else pipeline[pipeline.length - 1].push(tok); });
        var res = runSimple(pipeline[0]);
        lastOk = !res.some(function (l) { return /^(error|Error|E:|bash:|ERROR|curl: \(|sed:|cat:)/.test(l); });
        for (var p = 1; p < pipeline.length; p++) res = pipe(pipeline[p], res);
        out = out.concat(res);
      }
      return out;
    }

    function pipe(cmdTokens, input) {
      var cmd = cmdTokens[0], args = cmdTokens.slice(1);
      if (cmd === 'grep') {
        var inv = false, ci = false, after = 0, before = 0, pats = [];
        for (var i = 0; i < args.length; i++) { var a = args[i]; if (a === '-v') inv = true; else if (a === '-i') ci = true; else if (a === '-A') after = parseInt(args[++i], 10); else if (/^-A\d+$/.test(a)) after = parseInt(a.slice(2), 10); else if (a === '-B') before = parseInt(args[++i], 10); else if (/^-B\d+$/.test(a)) before = parseInt(a.slice(2), 10); else if (a === '-E' || a === '-e') { if (a === '-e') pats.push(args[++i]); } else if (a[0] === '-' && a.length > 1 && !/^-\d/.test(a)) { /* ignorar */ } else pats.push(a); }
        if (!pats.length) return ['Usage: grep [OPTION]... PATTERNS [FILE]...'];
        var re; try { re = new RegExp(pats.join('|'), ci ? 'i' : ''); } catch (e) { return ['grep: ' + e.message]; }
        var keep = {};
        input.forEach(function (l, idx) { if (re.test(l) !== inv) { for (var k = Math.max(0, idx - before); k <= Math.min(input.length - 1, idx + after); k++) keep[k] = true; } });
        return input.filter(function (l, idx) { return keep[idx]; });
      }
      if (cmd === 'wc') return [String(args.indexOf('-l') >= 0 || !args.length ? input.length : input.join('\n').length)];
      if (cmd === 'head') { var n = 10; for (var j = 0; j < args.length; j++) { if (args[j] === '-n') n = parseInt(args[++j], 10); else if (/^-\d+$/.test(args[j])) n = parseInt(args[j].slice(1), 10); } return input.slice(0, n); }
      if (cmd === 'tail') { var m = 10; for (var q = 0; q < args.length; q++) { if (args[q] === '-n') m = parseInt(args[++q], 10); else if (/^-\d+$/.test(args[q])) m = parseInt(args[q].slice(1), 10); } return input.slice(-m); }
      if (cmd === 'sort') return input.slice().sort();
      if (cmd === 'uniq') return input.filter(function (l, i) { return i === 0 || l !== input[i - 1]; });
      if (cmd === 'awk') { var fm = (args.join(' ')).match(/\$(\d+)/g); if (!fm) return input; var cols = fm.map(function (f) { return parseInt(f.slice(1), 10); }); return input.map(function (l) { var parts = l.trim().split(/\s+/); return cols.map(function (c) { return c === 0 ? l : (parts[c - 1] || ''); }).join(' '); }); }
      if (cmd === 'cut') { var d = ' ', f = 1; for (var r = 0; r < args.length; r++) { if (args[r] === '-d') d = args[++r]; else if (/^-d/.test(args[r])) d = args[r].slice(2); else if (args[r] === '-f') f = parseInt(args[++r], 10); else if (/^-f/.test(args[r])) f = parseInt(args[r].slice(2), 10); } return input.map(function (l) { return (l.split(d)[f - 1] || ''); }); }
      if (cmd === 'jq' || cmd === 'yq') return input.concat(['# (simulador) ' + cmd + ' no está disponible; usa -o yaml o -o jsonpath en tu máquina.']);
      if (cmd === 'less' || cmd === 'more' || cmd === 'cat' || cmd === 'tee') return input;
      if (cmd === 'xargs') return ['# (simulador) xargs no está soportado.'];
      return ['bash: ' + cmd + ': command not found'];
    }

    // Autocompletado simple
    function complete(line) {
      var parts = line.split(/\s+/);
      var cur = parts[parts.length - 1];
      var prev = parts[parts.length - 2] || '';
      var cands = [];
      var fileNames = Object.keys(files);
      if (parts.length === 1) cands = ['kubectl', 'kind', 'docker', 'curl', 'cat', 'ls', 'sed', 'grep', 'alias', 'export', 'clear', 'reset', 'help', 'tutorial', 'history'].concat(Object.keys(S.aliases));
      else if (prev === '-f' || prev === 'cat' || prev === '--config' || prev === 'sed' || /\.ya?ml$/.test(prev) === false && (prev === 'head' || prev === 'tail')) cands = fileNames;
      else {
        var first = S.aliases[parts[0]] ? S.aliases[parts[0]].split(' ')[0] : parts[0];
        if (first === 'kubectl') {
          var subs = ['get', 'describe', 'apply', 'create', 'run', 'expose', 'delete', 'scale', 'set', 'rollout', 'logs', 'exec', 'patch', 'label', 'port-forward', 'top', 'explain', 'config', 'cluster-info', 'api-resources', 'edit', 'wait'];
          var nonFlags = parts.slice(1).filter(function (p) { return p[0] !== '-'; });
          if (nonFlags.length <= 1 && parts.length === 2) cands = subs;
          else if (parts[1] === 'rollout' && parts.length === 3) cands = ['status', 'history', 'restart', 'undo'];
          else if (parts[1] === 'set' && parts.length === 3) cands = ['image', 'resources', 'env'];
          else if (parts[1] === 'config' && parts.length === 3) cands = ['set-context', 'current-context', 'get-contexts', 'view'];
          else if (nonFlags.length === 2 && ['get', 'describe', 'delete', 'edit', 'explain', 'scale', 'expose', 'label', 'patch', 'rollout', 'top'].indexOf(parts[1]) >= 0 && parts.length >= 3 && cur.indexOf('/') < 0) { Object.keys(KINDS).forEach(function (k) { cands = cands.concat(KINDS[k].aliases); }); }
          else if (parts[1] === 'logs' || parts[1] === 'exec' || parts[1] === 'port-forward') { if (S.cluster) cands = list('pod', S.ns).map(function (p) { return p.metadata.name; }); }
          else {
            var k = kindOf(nonFlags[1] || (cur.indexOf('/') >= 0 ? cur.split('/')[0] : ''));
            if (k && S.cluster) { var prefix = cur.indexOf('/') >= 0 ? cur.split('/')[0] + '/' : ''; cands = (k === 'node' ? S.cluster.nodes.map(function (n) { return n.name; }) : list(k === 'endpoints' ? 'service' : k, S.ns).map(function (o) { return o.metadata.name; })).map(function (n) { return prefix + n; }); }
          }
          if (cur[0] === '-') cands = ['-n', '-A', '-o', '-l', '-f', '--show-labels', '--dry-run=client', '--replicas=', '--image=', '--port=', '--target-port=', '--type=', '-c', '--namespace=', '--all'];
        } else if (first === 'kind') { if (parts.length === 2) cands = ['create', 'delete', 'get', 'load', 'version']; else if (parts[1] === 'create' || parts[1] === 'delete') cands = ['cluster']; else if (parts[1] === 'load') cands = parts.length === 3 ? ['docker-image'] : Object.keys(S.images); else if (parts[1] === 'get') cands = ['clusters', 'nodes']; if (cur[0] === '-') cands = ['--name', '--config']; }
        else if (first === 'docker') { if (parts.length === 2) cands = ['build', 'run', 'images', 'ps', 'pull', 'version']; else cands = Object.keys(S.images); }
        else if (first === 'curl') cands = ['http://catalogo.localtest.me/actuator/health', 'localhost:8080/actuator/health'];
      }
      var hits = cands.filter(function (c) { return c.indexOf(cur) === 0 && c !== cur; });
      hits = hits.filter(function (c, i) { return hits.indexOf(c) === i; }).sort();
      if (!hits.length) return { line: line, options: [] };
      if (hits.length === 1) return { line: parts.slice(0, -1).concat([hits[0]]).join(' ') + (/[=\/]$/.test(hits[0]) ? '' : ' '), options: [] };
      var common = hits[0];
      hits.forEach(function (h) { while (h.indexOf(common) !== 0) common = common.slice(0, -1); });
      return { line: parts.slice(0, -1).concat([common]).join(' '), options: hits };
    }

    return { run: run, complete: complete, reset: reset, files: files, get state() { return S; } };
  }

  // ---------------------------------------------------------------------------
  // Exportar / UI
  // ---------------------------------------------------------------------------
  if (typeof module !== 'undefined' && module.exports) { module.exports = { createSim: createSim, tokenize: tokenize }; return; }
  global.KubeSim = { createSim: createSim };

  function initUI() {
    var root = document.getElementById('consola');
    if (!root) return;
    var screen = root.querySelector('.consola-screen');
    if (!global.Terminal || !global.jsyaml) {
      screen.innerHTML = '<p class="consola-fallback">No se pudieron cargar las librerías de la consola (xterm.js / js-yaml). Revisa tu conexión o abre los <a href="https://killercoda.com/playgrounds/scenario/kubernetes">playgrounds reales</a>.</p>';
      return;
    }
    var files = {};
    Array.prototype.forEach.call(root.querySelectorAll('.consola-file'), function (el) {
      files[el.getAttribute('data-name')] = el.textContent.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    });
    var sim = createSim(files);

    var isDark = !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') !== 'light';
    var term = new global.Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 3000,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
      theme: isDark
        ? { background: '#1b1a1f', foreground: '#e6e1e8', cursor: '#7253ed', selectionBackground: '#44415a', black: '#1b1a1f', red: '#ff7b72', green: '#7ee787', yellow: '#f2cc60', blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#e6e1e8', brightBlack: '#8b8794' }
        : { background: '#f5f6fa', foreground: '#27262b', cursor: '#7253ed', selectionBackground: '#d6d9e4', black: '#27262b', red: '#c0392b', green: '#1e7f4f', yellow: '#946200', blue: '#1b5fb4', magenta: '#6f42c1', cyan: '#0a7c8a', white: '#27262b', brightBlack: '#6c6a74' }
    });
    var fit = global.FitAddon && global.FitAddon.FitAddon ? new global.FitAddon.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    term.open(screen);
    function refit() { if (fit) { try { fit.fit(); } catch (e) { /* ignore */ } } }
    refit();
    window.addEventListener('resize', refit);

    var C = { reset: '\u001b[0m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[34m', magenta: '\u001b[35m', cyan: '\u001b[36m', bold: '\u001b[1m' };
    function prompt() {
      var st = sim.state;
      var ctx = st.cluster ? C.cyan + 'kind-' + st.cluster.name + C.reset + ':' + C.magenta + st.ns + C.reset : C.dim + 'sin-clúster' + C.reset;
      return C.green + 'student' + C.reset + '@' + C.blue + 'softav' + C.reset + ' (' + ctx + ') ' + C.bold + '$' + C.reset + ' ';
    }
    function colorize(line) {
      if (/^(error|Error from server|E: |bash: |ERROR|curl: \(|sed: |cat: |The connection to the server)/.test(line)) return C.red + line + C.reset;
      if (/^#/.test(line)) return C.dim + C.yellow + line + C.reset;
      if (/\b(ImagePullBackOff|ErrImagePull|CrashLoopBackOff|OOMKilled|CreateContainerConfigError|Init:\d|Pending|ContainerCreating|Warning)\b/.test(line)) return line.replace(/\b(ImagePullBackOff|ErrImagePull|CrashLoopBackOff|OOMKilled|CreateContainerConfigError|Init:\d+\/\d+|ContainerCreating|Warning)\b/g, C.yellow + '$1' + C.reset);
      if (/ (created|configured|scaled|patched|exposed|deleted|restarted|rolled back|image updated)$/.test(line)) return C.green + line + C.reset;
      if (/^(NAME|NAMESPACE|REPOSITORY|CONTAINER ID|REVISION|CURRENT)\b/.test(line)) return C.bold + line + C.reset;
      return line;
    }

    var buffer = '', hist = [], histIdx = -1, savedLine = '';
    function redraw() { term.write('\r\u001b[K' + prompt() + buffer); }
    function execute(line) {
      term.write('\r\n');
      var out;
      try { out = sim.run(line); } catch (e) { out = ['error interno del simulador: ' + e.message, '# Reporta el comando que lo causó. Puedes seguir usando la consola.']; }
      if (out.length && out[0] === '\u001bc') { term.clear(); out = out.slice(1); }
      out.forEach(function (l) { term.writeln(colorize(l)); });
      if (line.trim()) { hist.push(line); if (hist.length > 200) hist.shift(); }
      histIdx = -1; buffer = '';
      term.write(prompt());
    }

    term.onData(function (data) {
      for (var i = 0; i < data.length; i++) {
        var ch = data[i];
        if (ch === '\u001b') {
          var seqStr = data.slice(i, i + 3);
          if (seqStr === '\u001b[A') { if (hist.length) { if (histIdx === -1) { savedLine = buffer; histIdx = hist.length; } if (histIdx > 0) histIdx--; buffer = hist[histIdx]; redraw(); } i += 2; continue; }
          if (seqStr === '\u001b[B') { if (histIdx !== -1) { histIdx++; if (histIdx >= hist.length) { histIdx = -1; buffer = savedLine; } else buffer = hist[histIdx]; redraw(); } i += 2; continue; }
          // ignorar otras secuencias (flechas izq/der, etc.)
          while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) i++;
          i++;
          continue;
        }
        if (ch === '\r' || ch === '\n') { if (ch === '\n' && data[i - 1] === '\r') continue; execute(buffer); continue; }
        if (ch === '\u007F' || ch === '\b') { if (buffer.length) { buffer = buffer.slice(0, -1); term.write('\b \b'); } continue; }
        if (ch === '\u0003') { term.write('^C\r\n' + prompt()); buffer = ''; histIdx = -1; continue; }
        if (ch === '\u000C') { term.clear(); redraw(); continue; }
        if (ch === '\u0015') { buffer = ''; redraw(); continue; }
        if (ch === '\u0017') { buffer = buffer.replace(/\S*\s*$/, ''); redraw(); continue; }
        if (ch === '\t') {
          var r = sim.complete(buffer);
          if (r.options.length) { term.write('\r\n' + r.options.join('  ') + '\r\n'); }
          buffer = r.line; redraw(); continue;
        }
        if (ch >= ' ' || ch.charCodeAt(0) > 127) { buffer += ch; term.write(ch); }
      }
    });

    // chips con comandos sugeridos
    Array.prototype.forEach.call(root.querySelectorAll('[data-cmd]'), function (btn) {
      btn.addEventListener('click', function () {
        var cmd = btn.getAttribute('data-cmd');
        buffer = cmd; redraw();
        if (btn.getAttribute('data-run') !== 'false') execute(cmd);
        term.focus();
      });
    });
    var resetBtn = root.querySelector('.consola-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () { term.clear(); execute('reset'); term.focus(); });

    term.writeln(C.bold + 'Consola del curso' + C.reset + ' · simulador de ' + C.cyan + 'kubectl' + C.reset + ', ' + C.cyan + 'kind' + C.reset + ' y ' + C.cyan + 'docker' + C.reset + ' en tu navegador.');
    term.writeln(C.dim + 'No hay clúster real detrás. Escribe ' + C.reset + 'help' + C.dim + ' o ' + C.reset + 'tutorial' + C.dim + ' para empezar; ' + C.reset + 'ls' + C.dim + ' muestra los manifiestos del curso.' + C.reset);
    term.writeln('');
    term.write(prompt());
    if (root.getAttribute('data-autofocus') === 'true') term.focus();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();
  }
})(typeof window !== 'undefined' ? window : this);
