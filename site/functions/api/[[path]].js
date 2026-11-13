// Cloudflare Pages Function
// Routes: GET /api/hall and POST /api/apply
// Required bindings: APPS_SCRIPT_URL, APPS_SCRIPT_TOKEN; optional: BLOCKED_APPLICATION_IPS

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

function normalizeIp(value) {
  let ip = cleanText(value, 64).toLowerCase();

  // IPv6 주소를 대괄호로 입력한 경우 대괄호를 제거합니다.
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  // IPv6 축약 표기가 서로 달라도 같은 주소로 비교할 수 있도록 정규화합니다.
  if (ip.includes(':')) {
    try {
      return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
    } catch (_) {
      // 잘못된 주소 형식은 원문으로 비교합니다. 유효한 Cloudflare IP는 정상 정규화됩니다.
    }
  }

  return ip;
}

function getClientIp(request) {
  // 클라이언트가 전송한 신청 데이터가 아닌 Cloudflare가 전달한 IP만 사용합니다.
  return normalizeIp(request.headers.get('CF-Connecting-IP'));
}

function getBlockedApplicationIps(value) {
  // 쉼표, 세미콜론 또는 줄바꿈으로 구분한 정확한 IP 주소 목록입니다.
  return new Set(
    String(value ?? '')
      .split(/[,;\r\n]+/)
      .map(normalizeIp)
      .filter(Boolean)
  );
}

function isBlockedApplicationIp(clientIp, blockedIpsValue) {
  const normalizedClientIp = normalizeIp(clientIp);
  if (!normalizedClientIp) return false;
  return getBlockedApplicationIps(blockedIpsValue).has(normalizedClientIp);
}

function getClientCountry(request) {
  // Cloudflare Pages Function의 request.cf.country를 우선 사용하고,
  // 값이 없을 때만 CF-IPCountry 헤더를 확인합니다.
  const cfCountry = cleanText(request.cf?.country, 2).toUpperCase();
  const headerCountry = cleanText(request.headers.get('CF-IPCountry'), 2).toUpperCase();
  return cfCountry || headerCountry;
}

function isAllowedKoreanRequest(request, clientIp = getClientIp(request)) {
  const country = getClientCountry(request);

  // Cloudflare가 전달한 연결 IP가 없거나 대한민국(KR)이 아니면 차단합니다.
  return Boolean(clientIp) && country === 'KR';
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

  // 개별 IP 차단은 가입 신청서 제출(POST)에만 적용합니다.
  // 홈페이지와 명예의 전당 조회(GET)는 BLOCKED_APPLICATION_IPS의 영향을 받지 않습니다.
  const clientIp = isApplyRequest ? getClientIp(request) : '';
  if (isApplyRequest && isBlockedApplicationIp(clientIp, env.BLOCKED_APPLICATION_IPS)) {
    return jsonResponse({
      result: 'error',
      code: 'BLOCKED_APPLICATION_IP',
      message: '등록된 IP 주소에서는 가입 신청을 할 수 없습니다.'
    }, 403);
  }

  // 기존 국내 IP 검사는 그대로 유지합니다. IP/국가 정보가 없거나 KR이 아니면 거부합니다.
  if (isApplyRequest && !isAllowedKoreanRequest(request, clientIp)) {
    return jsonResponse({
      result: 'error',
      code: 'KOREAN_IP_REQUIRED',
      message: '가입 신청은 대한민국(KR) IP에서만 가능합니다.'
    }, 403);
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
    const cloudflareIp = clientIp || '확인 불가';

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
