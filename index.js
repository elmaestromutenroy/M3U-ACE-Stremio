const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const crypto = require("crypto");

// --- 1. CONFIGURACIÓN ---
const CONFIG = {
    m3uUrl: "http://coincity.tk/f/acem3u.m3u"
    // EPG Desactivado para evitar caída de memoria
};

// --- 2. GESTOR DE DATOS ---
class AceManager {
    constructor() {
        this.channels = [];
    }

    async updateData() {
        console.log("--> [UPDATE] Descargando lista...");
        try {
            const res = await fetch(CONFIG.m3uUrl);
            if(res.ok) {
                const text = await res.text();
                this.channels = this.parseM3U(text);
                console.log(`--> [LISTA] Éxito: ${this.channels.length} canales cargados.`);
            } else {
                console.log(`--> [ERROR] Estado HTTP: ${res.status}`);
            }
        } catch (e) {
            console.log("--> [ERROR] Red:", e.message);
        }
    }

    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;

        lines.forEach(line => {
            const l = line.trim();
            if (l.startsWith('#EXTINF:')) {
                const info = l.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (info) {
                    const attrs = {};
                    const attrRaw = info[2] || '';
                    const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
                    let m;
                    while ((m = regex.exec(attrRaw)) !== null) attrs[m[1]] = m[2];
                    
                    const fullName = (info[3] || '').trim();
                    
                    // IMPORTANTE: Si no hay group-title, poner OTROS para que no falle
                    const group = attrs['group-title'] || 'OTROS';

                    currentItem = {
                        name: fullName,
                        logo: attrs['tvg-logo'],
                        group: group,
                        // ID robusto
                        id: 'ace_' + crypto.createHash('md5').update(fullName).digest('hex')
                    };
                }
            } else if (l && !l.startsWith('#') && currentItem) {
                currentItem.url = l;
                items.push(currentItem);
                currentItem = null;
            }
        });
        return items;
    }

    // Función para sacar los géneros únicos de la lista cargada
    getGenres() {
        const groups = new Set(this.channels.map(c => c.group));
        return [...groups].sort();
    }
}

// --- 3. ARRANQUE ASÍNCRONO (LA CLAVE) ---
async function startAddon() {
    const manager = new AceManager();
    
    // 1. ESPERAMOS a que cargue la lista ANTES de crear el addon
    await manager.updateData();
    
    // 2. Ahora que tenemos datos, creamos los géneros
    const dynamicGenres = manager.getGenres();
    console.log("--> [GÉNEROS] Detectados:", dynamicGenres);

    // 3. Definimos el Manifiesto CON los géneros ya cargados
    const manifest = {
        id: "org.milista.acestream",
        version: "1.0.2",
        name: "Mi Lista ACE",
        description: "Lista privada con Categorías",
        resources: ["catalog", "meta", "stream"],
        types: ["AceStream"],
        catalogs: [
            {
                type: "AceStream",
                id: "mi_lista",
                name: "Mi Lista",
                extra: [{ name: "genre", isRequired: false }, { name: "search" }],
                // AQUÍ LA MAGIA: Inyectamos los géneros cargados
                genres: dynamicGenres
            }
        ],
        idPrefixes: ["ace_"]
    };

    const builder = new addonBuilder(manifest);

    // --- HANDLERS ---
    
    builder.defineCatalogHandler((args) => {
        if (args.type === "AceStream" && args.id === "mi_lista") {
            let items = manager.channels;
            
            // Filtrar por Género seleccionado en Stremio
            if (args.extra && args.extra.genre) {
                items = items.filter(i => i.group === args.extra.genre);
            }
            
            // Filtrar por Búsqueda
            if (args.extra && args.extra.search) {
                items = items.filter(i => i.name.toLowerCase().includes(args.extra.search.toLowerCase()));
            }

            const metas = items.map(c => ({
                id: c.id,
                type: "AceStream",
                name: c.name,
                poster: c.logo,
                description: c.group
            }));
            return Promise.resolve({ metas: metas });
        }
        return Promise.resolve({ metas: [] });
    });

    builder.defineMetaHandler((args) => {
        const channel = manager.channels.find(c => c.id === args.id);
        if (!channel) return Promise.resolve({ meta: null });

        return Promise.resolve({
            meta: {
                id: channel.id,
                type: "AceStream",
                name: channel.name,
                poster: channel.logo,
                background: channel.logo,
                description: `Grupo: ${channel.group}`,
                releaseInfo: "LIVE",
                behaviorHints: { isLive: true }
            }
        });
    });

    builder.defineStreamHandler((args) => {
        const channel = manager.channels.find(c => c.id === args.id);
        if (!channel) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                url: channel.url,
                title: "Ver en AceStream",
                behaviorHints: { notWebReady: true }
            }]
        });
    });

    // 4. ENCENDEMOS EL SERVIDOR
    const addonInterface = builder.getInterface();
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    console.log("--> [SERVIDOR] Online y escuchando.");
    
    // (Opcional) Actualizar lista en segundo plano cada hora
    // Nota: Los géneros nuevos NO saldrán hasta reiniciar el addon, 
    // pero los canales nuevos dentro de géneros existentes SÍ saldrán.
    setInterval(() => manager.updateData(), 36000 * 1000);
}

// Ejecutar todo
startAddon();
