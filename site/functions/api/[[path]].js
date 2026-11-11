// Cloudflare Pages Function
// Routes: GET /api/hall and POST /api/apply
// Required encrypted bindings: APPS_SCRIPT_URL and APPS_SCRIPT_TOKEN

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function cleanText(value, maxLength = 120) {
  return String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLength);
}

function inferOS(platformHint, platformVersion, userAgent) {
  const platform = cleanText(platformHint, 50).toLowerCase();
  const ua = String(userAgent || '');
  let name = '';
  let version = cleanText(platformVersion, 30);

  if (platform.includes('android') || /Android/i.test(ua)) {
    name = 'Android';
    if (!version) version = ua.match(/Android\s([\d.]+)/i)?.[1] || '';
  } else if (platform.includes('ios') || /iPhone|iPad|iPod/i.test(ua)) {
    name = 'iOS';
    if (!version) version = ua.match(/OS\s([\d_]+)/i)?.[1]?.replace(/_/g, '.') || '';
  } else if (platform.includes('windows') || /Windows NT/i.test(ua)) {
    name = 'Windows';
    if (!version) {
      const nt = ua.match(/Windows NT\s([\d.]+)/i)?.[1];
      version = nt === '10.0' ? '10/11' : (nt || '');
    }
  } else if (platform.includes('mac') || /Mac OS X|Macintosh/i.test(ua)) {
    name = 'macOS';
    if (!version) version = ua.match(/Mac OS X\s([\d_]+)/i)?.[1]?.replace(/_/g, '.') || '';
  } else if (platform.includes('chrome') || /CrOS/i.test(ua)) {
    name = 'ChromeOS';
  } else if (platform.includes('linux') || /Linux/i.test(ua)) {
    name = 'Linux';
  } else {
    name = cleanText(platformHint, 50) || '확인 불가';
  }

  return version ? `${name} ${version}` : name;
}

function inferDevice(modelHint, userAgent) {
  const hint = cleanText(modelHint, 80);
  if (hint && !/^(unknown|generic)$/i.test(hint)) return hint;

  const ua = String(userAgent || '');
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPod/i.test(ua)) return 'iPod';

  const android = ua.match(/Android\s[\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]+)?[;)]/i);
  if (android?.[1]) {
    const candidate = cleanText(android[1].replace(/^\s*(?:wv|U;?)\s*/i, ''), 80);
    if (candidate && !/^[a-z]{2}-[a-z]{2}$/i.test(candidate)) return candidate;
  }
  if (/Android/i.test(ua)) return 'Android 기기(모델 미확인)';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows|X11|Linux|CrOS/i.test(ua)) return 'PC';
  return '확인 불가';
}

async function relayToAppsScript(url, options) {
  const upstream = await fetch(url.toString(), { ...options, redirect: 'follow' });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const isHallRequest = path === '/api/hall' && request.method === 'GET';
  const isApplyRequest = path === '/api/apply' && request.method === 'POST';

  if (!isHallRequest && !isApplyRequest) {
    return jsonResponse({ result: 'error', message: 'Not found' }, 404);
  }

  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_TOKEN) {
    return jsonResponse({ result: 'error', message: 'Cloudflare 서버 설정이 완료되지 않았습니다.' }, 500);
  }

  let appsScriptUrl;
  try {
    appsScriptUrl = new URL(env.APPS_SCRIPT_URL);
    if (appsScriptUrl.protocol !== 'https:' || appsScriptUrl.hostname !== 'script.google.com') {
      return jsonResponse({ result: 'error', message: 'APPS_SCRIPT_URL 설정을 확인해주세요.' }, 500);
    }
  } catch (_) {
    return jsonResponse({ result: 'error', message: 'APPS_SCRIPT_URL 설정을 확인해주세요.' }, 500);
  }

  try {
    if (isHallRequest) {
      appsScriptUrl.searchParams.set('backendToken', env.APPS_SCRIPT_TOKEN);
      return await relayToAppsScript(appsScriptUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > 100_000) {
      return jsonResponse({ result: 'error', message: '신청 데이터가 너무 큽니다.' }, 413);
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (_) {
      return jsonResponse({ result: 'error', message: '잘못된 신청 데이터입니다.' }, 400);
    }

    const deviceInfo = data.deviceInfo && typeof data.deviceInfo === 'object' ? data.deviceInfo : {};
    const userAgent = request.headers.get('User-Agent') || '';
    const cloudflareIp = cleanText(request.headers.get('CF-Connecting-IP') || '확인 불가', 64);

    // IP는 브라우저 입력값을 신뢰하지 않고 Cloudflare가 전달한 연결 IP로 덮어씁니다.
    const payload = {
      ...data,
      ipAddress: cloudflareIp,
      os: inferOS(deviceInfo.platform, deviceInfo.platformVersion, userAgent),
      device: inferDevice(deviceInfo.model, userAgent),
      backendToken: env.APPS_SCRIPT_TOKEN
    };
    delete payload.deviceInfo;

    return await relayToAppsScript(appsScriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return jsonResponse({ result: 'error', message: '백엔드 서버와 통신하지 못했습니다.' }, 502);
  }
}
