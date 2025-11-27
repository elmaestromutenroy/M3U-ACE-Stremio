<?php
// ================= CONFIGURACIÓN =================
$cacheFile   = __DIR__ . '/cache/lista_iptv_cache.m3u';  // Archivo donde se guarda la caché
$cacheTime   = 5 * 24 * 60 * 60;  // 5 días en segundos
$sourceUrl   = 'https://ipfs.io/ipns/k2k4r8oqlcjxsritt5mczkcn4mmvcmymbqw7113fz2flkrerfwfps004/data/listas/lista_iptv.m3u';
$replaceFrom = ['127.0.0.1', 'localhost'];
$replaceTo   = '192.168.18.50';
// =================================================

// Crear carpeta cache si no existe
$cacheDir = dirname($cacheFile);
if (!is_dir($cacheDir)) {
    mkdir($cacheDir, 0755, true);
}

// ¿Existe caché reciente?
if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTime) {
    $content = file_get_contents($cacheFile);
} else {
    // Descargar desde IPFS
    $context = stream_context_create([
        'http' => [
            'timeout' => 30,
            'user_agent' => 'PHP IPTV Proxy'
        ]
    ]);

    $content = file_get_contents($sourceUrl, false, $context);

    if ($content === false) {
        // Si falla y hay caché vieja (aunque esté caducada), la usamos como fallback
        if (file_exists($cacheFile)) {
            header('HTTP/1.1 503 Service Temporarily Unavailable');
            header('Retry-After: 300');
            $content = file_get_contents($cacheFile);
            $content = "# CACHÉ ANTIGUA (IPFS no responde)\n" . $content;
        } else {
            http_response_code(503);
            die('Error: No se pudo conectar con IPFS y no hay caché disponible.');
        }
    } else {
        // Procesar el contenido nuevo
        $content = processM3u($content);

        // Guardar en caché
        file_put_contents($cacheFile, $content);
    }
}

// Si llegamos aquí, ya tenemos $content listo (nuevo o de caché)

// Enviar al usuario
header('Content-Type: application/x-mpegURL');
header('Content-Disposition: attachment; filename="lista.m3u"');
header('Cache-Control: no-cache, must-revalidate');
header('Expires: 0');
header('Content-Length: ' . strlen($content));
header('X-Cache: ' . (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTime ? 'HIT' : 'MISS'));

echo $content;
exit;

// ===============================================
// Función que limpia y modifica el M3U
function processM3u($text) {
    $lines = explode("\n", $text);
    $newLines = [];

    foreach ($lines as $line) {
        $trimmed = trim($line);

        // Eliminar cualquier línea que empiece por #EXTGRP (con o sin dos puntos, mayúsculas/minúsculas)
        if (preg_match('/^#EXTGRP\s*[:]?/i', $trimmed)) {
            continue;
        }

        // Reemplazar IPs/localhost
        $line = str_replace(['127.0.0.1', 'localhost'], '192.168.18.50', $line);

        $newLines[] = $line;
    }

    return implode("\n", $newLines);
}
