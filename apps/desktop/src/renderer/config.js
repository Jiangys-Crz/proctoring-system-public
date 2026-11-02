window.PROCTOR_DEFAULT_SERVER_URL = 'http://localhost:4031';
// 正式安装包填写可信 HTTPS 后台地址；留空使用上面的后台地址。
window.PROCTOR_UPDATE_SERVER_URL = '';
window.PROCTOR_RELEASE_CHANNEL = 'public';
// 桌面开发客户端与服务运行在同一台电脑，使用回环地址避免 Wi-Fi/热点切换后旧局域网 IP 失效。
window.PROCTOR_CLIENT_WEB_URL = 'http://127.0.0.1:4032';
// 手机持续摄像需要可信 HTTPS；在此填写本机可访问的 HTTPS 入口。
window.PROCTOR_MOBILE_WEB_URL = '';
// 手机可访问的 HTTPS 后台地址；按实际部署填写。
window.PROCTOR_PUBLIC_API_URL = '';
// 电脑屏幕和电脑摄像头推流服务可与 API 使用不同域名，留空时回退到 API 主机的 1935 端口。
window.PROCTOR_MEDIA_RTMP_BASE = '';
