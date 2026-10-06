// Conector con la API de Playoff. Las credenciales SOLO salen de variables de
// entorno de Vercel: nunca viajan al navegador ni se guardan en el codigo.
//
// Variables que hay que definir en Vercel:
//   PLAYOFF_HOST  -> p.ej. rollerfun.playoffinformatica.com   (sin https://)
//   PLAYOFF_USER  -> usuario de la API de Playoff
//   PLAYOFF_PASS  -> contrasena de la API de Playoff
//   PANEL_CLAVE   -> clave que protege el panel (la eliges tu)

const BASE = '/api.php/api/v1.0';

let cache = { token: null, exp: 0 };

function cfg() {
  const host = (process.env.PLAYOFF_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    host,
    user: process.env.PLAYOFF_USER || '',
    pass: process.env.PLAYOFF_PASS || '',
    clave: process.env.PANEL_CLAVE || ''
  };
}

function faltan(c) {
  const f = [];
  if (!c.host) f.push('PLAYOFF_HOST');
  if (!c.user) f.push('PLAYOFF_USER');
  if (!c.pass) f.push('PLAYOFF_PASS');
  if (!c.clave) f.push('PANEL_CLAVE');
  return f;
}

async function token(c) {
  const ahora = Date.now();
  if (cache.token && cache.exp > ahora + 30000) return cache.token;
  const r = await fetch('https://' + c.host + BASE + '/login/colegi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: c.user, password: c.pass })
  });
  const txt = await r.text();
  if (!r.ok) {
    const e = new Error('Playoff rechazo el login (' + r.status + '). ' + txt.slice(0, 300));
    e.status = r.status === 401 || r.status === 403 ? 401 : 502;
    throw e;
  }
  let j;
  try { j = JSON.parse(txt); } catch (_) { j = null; }
  const tk = j && (j.access_token || j.accessToken || j.token);
  if (!tk) {
    const e = new Error('Playoff contesto al login sin token: ' + txt.slice(0, 300));
    e.status = 502;
    throw e;
  }
  // El JWT trae su propia caducidad; si no se puede leer, caducamos a los 20 min.
  let exp = ahora + 20 * 60 * 1000;
  try {
    const p = JSON.parse(Buffer.from(tk.split('.')[1], 'base64').toString('utf8'));
    if (p && p.exp) exp = p.exp * 1000;
  } catch (_) {}
  cache = { token: tk, exp };
  return tk;
}

async function get(c, ruta, params) {
  const tk = await token(c);
  const u = new URL('https://' + c.host + BASE + ruta);
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
  });
  const r = await fetch(u.toString(), {
    headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json' }
  });
  if (r.status === 404) return null;
  if (r.status === 401) { cache = { token: null, exp: 0 }; }
  const txt = await r.text();
  if (!r.ok) {
    const e = new Error('Playoff ' + ruta + ' -> ' + r.status + ' ' + txt.slice(0, 200));
    e.status = 502;
    throw e;
  }
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_) { return null; }
}

// Lanza varias peticiones a la vez sin pasarse, para no tumbar a Playoff.
async function enLotes(items, n, fn) {
  const salida = [];
  for (let i = 0; i < items.length; i += n) {
    const trozo = items.slice(i, i + n);
    const res = await Promise.all(trozo.map(function (x) {
      return fn(x).catch(function (e) { return { __error: String(e && e.message || e), __item: x }; });
    }));
    res.forEach(function (r) { salida.push(r); });
  }
  return salida;
}

// Playoff acepta pageSize hasta 100; con 200 contesta 400. Y como no esta claro
// si la primera pagina es la 0 o la 1, se recorre desde 0 y se descartan los
// repetidos por id: si la paginacion no funcionara, se corta sola.
const TAM = 100;

function idDe(x) {
  return x && (x.idColegiat != null ? x.idColegiat : x.id);
}

async function todosColegiats(c) {
  const out = [];
  const vistos = {};
  for (let page = 0; page <= 80; page++) {
    const r = await get(c, '/colegiats', { page: page, pageSize: TAM });
    const arr = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : null);
    if (!arr || !arr.length) break;
    let nuevos = 0;
    arr.forEach(function (x) {
      const id = idDe(x);
      if (id == null || vistos[id]) return;
      vistos[id] = 1;
      out.push(x);
      nuevos++;
    });
    if (!nuevos) break;
    if (arr.length < TAM) break;
  }
  return out;
}

// Devuelve el codigo y el principio de la respuesta sin reventar: sirve para
// averiguar que combinacion de parametros acepta Playoff.
async function crudo(c, ruta, params, max) {
  const tk = await token(c);
  const u = new URL('https://' + c.host + BASE + ruta);
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
  });
  try {
    const r = await fetch(u.toString(), {
      headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json' }
    });
    const txt = await r.text();
    let n = null;
    try { const j = JSON.parse(txt); if (Array.isArray(j)) n = j.length; else if (j && Array.isArray(j.data)) n = j.data.length; } catch (_) {}
    return { url: u.pathname + u.search, status: r.status, n: n, muestra: txt.slice(0, max || 180) };
  } catch (e) {
    return { url: u.pathname + u.search, status: 0, error: String(e && e.message || e) };
  }
}

const ACCIONES = {
  // Comprueba que las credenciales valen, sin bajar datos.
  ping: async function (c) {
    await token(c);
    return { ok: true, host: c.host };
  },

  // Prueba varias formas de pedir los alumnos y dice cual acepta Playoff.
  diag: async function (c, q) {
    const id = String(q && q.id || '').trim();
    const pruebas = id ? [
      ['/colegiats/rebuts', { idColegiat: id }],
      ['/colegiats/rebuts', { idColegiat: id, page: 0 }],
      ['/colegiats/rebuts', { idColegiat: id, page: 1 }],
      ['/colegiats/rebuts', { idColegiat: id, page: 0, limit: 500 }],
      ['/colegiats/rebuts', { idColegiat: id, page: 1, limit: 100 }],
      ['/colegiats/rebuts', { idColegiat: id, limit: 100 }],
      ['/remeses/id_ultima_remesa', {}],
      ['/remeses/1', {}],
      ['/activitats', {}]
    ] : [
      ['/colegiats', {}],
      ['/colegiats', { page: 0 }],
      ['/colegiats', { page: 1 }],
      ['/colegiats', { page: 0, pageSize: 50 }],
      ['/colegiats', { page: 1, pageSize: 50 }],
      ['/colegiats', { page: 0, pageSize: 100 }],
      ['/colegiats', { pageSize: 50 }],
      ['/colegiats', { page: 0, limit: 50 }],
      ['/colegiats', { residencia: 'TOTS' }],
      ['/colegiats/meu', {}],
      ['/remeses/id_ultima_remesa', {}],
      ['/perfilsllistat', {}]
    ];
    const out = [];
    for (let i = 0; i < pruebas.length; i++) {
      out.push(await crudo(c, pruebas[i][0], pruebas[i][1]));
    }
    return { pruebas: out };
  },

  // Consulta libre de solo lectura a una ruta de Playoff. Sirve para explorar sin
  // tener que volver a desplegar cada vez. Solo GET y solo contra tu propio host.
  probar: async function (c, q) {
    const ruta = '/' + String(q.ruta || '').replace(/^\/+/, '').split('?')[0];
    const params = {};
    String(q.qs || '').split('&').forEach(function (par) {
      if (!par) return;
      const i = par.indexOf('=');
      if (i > 0) params[par.slice(0, i)] = par.slice(i + 1);
    });
    const r = await crudo(c, ruta, params, 6000);
    return { prueba: r };
  },

  // Catalogos pequenos: periodicidades, modalidades, estados, actividades.
  catalogos: async function (c) {
    const [periodicitats, modalitats, estats, agrupacions, activitats] = await Promise.all([
      get(c, '/tipusperiodicitats').catch(function () { return null; }),
      get(c, '/modalitats').catch(function () { return null; }),
      get(c, '/estatscolegiat').catch(function () { return null; }),
      get(c, '/agrupacions').catch(function () { return null; }),
      get(c, '/activitats/totes').catch(function () { return null; })
    ]);
    return { periodicitats, modalitats, estats, agrupacions, activitats };
  },

  // Todos los alumnos, con su estado y sus cuotas.
  colegiats: async function (c) {
    const l = await todosColegiats(c);
    return { colegiats: l, n: l.length, paginas: Math.ceil(l.length / TAM) };
  },

  // Los recibos. Playoff los da alumno por alumno, asi que se piden por tramos
  // y el navegador va pidiendo el siguiente: una sola llamada no cabe en el
  // tiempo maximo de una funcion.
  rebuts: async function (c, q) {
    const ids = String(q.ids || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!ids.length) { const e = new Error('Hacen falta ids de alumno'); e.status = 400; throw e; }
    const res = await enLotes(ids, 8, async function (id) {
      const r = await get(c, '/colegiats/rebuts', { idColegiat: id });
      return { idColegiat: id, rebuts: Array.isArray(r) ? r : [] };
    });
    const rebuts = [];
    const errores = [];
    res.forEach(function (x) {
      if (x && x.__error) { errores.push({ idColegiat: x.__item, error: x.__error }); return; }
      (x.rebuts || []).forEach(function (rb) {
        if (rb && rb.idColegiat == null) rb.idColegiat = Number(x.idColegiat);
        rebuts.push(rb);
      });
    });
    return { rebuts: rebuts, errores: errores, pedidos: ids.length };
  },

  // Remesas: se recorren desde la ultima hacia atras.
  remeses: async function (c, q) {
    const desde = Number(q.desde || 1);
    const hasta = Number(q.hasta || 0);
    let fin = hasta;
    if (!fin) {
      const u = await get(c, '/remeses/id_ultima_remesa');
      fin = Number((u && (u.idRemesa || u.id || u)) || 0);
    }
    if (!fin || fin < desde) return { remeses: [], ultima: fin };
    const ids = [];
    for (let i = desde; i <= fin; i++) ids.push(i);
    const res = await enLotes(ids, 8, async function (id) {
      const r = await get(c, '/remeses/' + id);
      if (!r) return null;
      if (r.idRemesa == null) r.idRemesa = id;
      return r;
    });
    return { remeses: res.filter(function (x) { return x && !x.__error; }), ultima: fin };
  },

  // Comisiones y gastos que Playoff asocia a cada remesa.
  despesesRemesa: async function (c, q) {
    const ids = String(q.ids || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    const res = await enLotes(ids, 8, async function (id) {
      const r = await get(c, '/controldespeses/remesa/' + id);
      return { idRemesa: Number(id), despeses: Array.isArray(r) ? r : (r ? [r] : []) };
    });
    return { lineas: res.filter(function (x) { return x && !x.__error; }) };
  },

  // Inscripciones por actividad: dice que grupo genera que ingreso.
  inscripcions: async function (c, q) {
    const ids = String(q.ids || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    const res = await enLotes(ids, 6, async function (id) {
      const r = await get(c, '/inscripcions', { idActivitat: id });
      return { idActivitat: Number(id), inscripcions: Array.isArray(r) ? r : [] };
    });
    return { grupos: res.filter(function (x) { return x && !x.__error; }) };
  },

  // Fichajes de monitores: adios al Excel de horas.
  horari: async function (c, q) {
    const r = await get(c, '/registrehorari/llistat/mensual', {
      any: q.any, mes: q.mes, idColegiat: q.idColegiat, data: q.data, nif: q.nif
    });
    return { horari: r };
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const c = cfg();

  const f = faltan(c);
  if (f.length) {
    res.status(500).json({
      error: 'Falta configuracion en Vercel',
      faltan: f,
      comollo: 'Anade esas variables en Vercel > Settings > Environment Variables y vuelve a desplegar.'
    });
    return;
  }

  const q = req.query || {};
  const clave = req.headers['x-panel-clave'] || q.clave || '';
  if (String(clave) !== c.clave) {
    res.status(401).json({ error: 'Clave del panel incorrecta' });
    return;
  }

  const accion = String(q.accion || q.a || 'ping');
  const fn = ACCIONES[accion];
  if (!fn) {
    res.status(400).json({ error: 'Accion desconocida: ' + accion, acciones: Object.keys(ACCIONES) });
    return;
  }

  const t0 = Date.now();
  try {
    const data = await fn(c, q);
    data.ms = Date.now() - t0;
    res.status(200).json(data);
  } catch (e) {
    res.status(e && e.status ? e.status : 500).json({
      error: String(e && e.message || e),
      accion: accion,
      ms: Date.now() - t0
    });
  }
};
