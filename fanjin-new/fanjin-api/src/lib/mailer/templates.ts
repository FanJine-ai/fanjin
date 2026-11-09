import fs from "node:fs";
import path from "node:path";

export type MailBrandOptions = {
  /** Absolute URL preferred, e.g. https://fanjin.top/assets/fanjin-logo-fj.png */
  logoUrl?: string;
  brandName?: string;
};

function brandHeader(options: MailBrandOptions = {}): { textPrefix: string; htmlHeader: string } {
  const brandName = options.brandName || "繁境 Fanjin";
  const logoUrl = String(options.logoUrl || "").trim();
  const textPrefix = `${brandName}\n`;
  const logoBlock = logoUrl
    ? `<div style="margin:0 0 16px 0">
  <img src="${escapeHtml(logoUrl)}" width="56" height="56" alt="${escapeHtml(brandName)}" style="display:block;border:0;outline:none;text-decoration:none;width:56px;height:56px;border-radius:12px" />
</div>`
    : "";
  const htmlHeader = `${logoBlock}<div style="margin:0 0 18px 0;font-size:18px;font-weight:800;letter-spacing:0.02em;color:#111827">${escapeHtml(brandName)}</div>`;
  return { textPrefix, htmlHeader };
}

export function buildEmailVerificationMessage(input: {
  verifyUrl: string;
  verificationCode: string;
  to: string;
  logoUrl?: string;
  brandName?: string;
}) {
  const subject = "验证你的繁境账号邮箱";
  const brand = brandHeader(input);
  const text = [
    brand.textPrefix.trimEnd(),
    "",
    "你好，",
    "",
    "感谢注册繁境（Fanjin）。",
    "",
    "请在 24 小时内打开以下链接完成邮箱验证：",
    "",
    input.verifyUrl,
    "",
    `安全码：${input.verificationCode}`,
    "",
    "安全码不会出现在链接中；跨设备打开时需要输入。",
    "",
    "验证完成后即可使用该账号登录。",
    "",
    "如果这不是你本人的操作，请忽略本邮件，该链接在 24 小时后失效。",
    "",
    "— 繁境团队",
  ].join("\n");
  const safeUrl = escapeHtml(input.verifyUrl);
  const safeCode = escapeHtml(input.verificationCode);
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px 24px;border:1px solid #e5e7eb">
          <tr>
            <td>
              ${brand.htmlHeader}
              <p style="margin:0 0 12px 0;line-height:1.7;font-size:15px">你好，</p>
              <p style="margin:0 0 12px 0;line-height:1.7;font-size:15px">感谢注册繁境（Fanjin）。请在 <strong>24 小时内</strong>完成邮箱验证：</p>
              <p style="margin:20px 0">
                <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">验证邮箱</a>
              </p>
              <p style="margin:0 0 8px 0;line-height:1.7;font-size:13px;color:#4b5563">若按钮无法打开，请复制链接：</p>
              <p style="margin:0 0 16px 0;word-break:break-all;line-height:1.6;font-size:13px;color:#2563eb">${safeUrl}</p>
              <p style="margin:0 0 8px 0;line-height:1.7;font-size:13px;color:#4b5563">跨设备打开时请输入安全码：</p>
              <p style="margin:0 0 16px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:800;letter-spacing:0.08em">${safeCode}</p>
              <p style="margin:0;line-height:1.7;font-size:13px;color:#6b7280">如果这不是你本人的操作，请忽略本邮件。</p>
              <p style="margin:18px 0 0 0;line-height:1.7;font-size:13px;color:#6b7280">— 繁境团队</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}

export function buildPasswordResetMessage(input: {
  resetUrl: string;
  resetCode: string;
  to: string;
  username?: string;
  logoUrl?: string;
  brandName?: string;
}) {
  const subject = "重置繁境账号密码";
  const brand = brandHeader(input);
  const text = [
    brand.textPrefix.trimEnd(),
    "",
    "你好，",
    "",
    "我们收到了重置繁境账号密码的请求。",
    "",
    "请在 30 分钟内打开以下链接重置密码：",
    "",
    input.resetUrl,
    "",
    `安全码：${input.resetCode}`,
    "",
    "安全码不会出现在链接中；跨设备打开时需要输入。",
    "",
    "如果不是你发起的请求，请忽略本邮件。",
    "",
    "— 繁境团队",
  ].join("\n");
  const safeUrl = escapeHtml(input.resetUrl);
  const safeCode = escapeHtml(input.resetCode);
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px 24px;border:1px solid #e5e7eb">
          <tr>
            <td>
              ${brand.htmlHeader}
              <p style="margin:0 0 12px 0;line-height:1.7;font-size:15px">你好，</p>
              <p style="margin:0 0 12px 0;line-height:1.7;font-size:15px">请在 <strong>30 分钟内</strong>打开链接重置密码：</p>
              <p style="margin:20px 0">
                <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">重置密码</a>
              </p>
              <p style="margin:0 0 8px 0;line-height:1.7;font-size:13px;color:#4b5563">若按钮无法打开，请复制链接：</p>
              <p style="margin:0 0 16px 0;word-break:break-all;line-height:1.6;font-size:13px;color:#2563eb">${safeUrl}</p>
              <p style="margin:0 0 8px 0;line-height:1.7;font-size:13px;color:#4b5563">跨设备打开时请输入安全码：</p>
              <p style="margin:0 0 16px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:800;letter-spacing:0.08em">${safeCode}</p>
              <p style="margin:0;line-height:1.7;font-size:13px;color:#6b7280">如果不是你发起的请求，请忽略本邮件。</p>
              <p style="margin:18px 0 0 0;line-height:1.7;font-size:13px;color:#6b7280">— 繁境团队</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}

export function resolveMailLogoUrl(publicBaseUrl?: string | null): string | undefined {
  const base = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return undefined;

  // Local preview links (127.0.0.1 / localhost) are not fetchable by QQ Mail servers.
  // Embed the PNG as a data URI so the logo still renders in received messages.
  try {
    const host = new URL(base).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0") {
      const candidates = [
        path.resolve(process.cwd(), "../fanjin-v4/public/assets/fanjin-logo-fj.png"),
        path.resolve(process.cwd(), "public/assets/fanjin-logo-fj.png"),
        path.resolve(process.cwd(), "data/web/assets/fanjin-logo-fj.png"),
      ];
      for (const file of candidates) {
        if (fs.existsSync(file)) {
          const buf = fs.readFileSync(file);
          return `data:image/png;base64,${buf.toString("base64")}`;
        }
      }
    }
  } catch {
    // fall through to absolute URL
  }

  return `${base}/assets/fanjin-logo-fj.png`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
