# Windows 7 检测修复说明

客户端版本：1.0.3（同一 Windows 安装包包含 32 位和 64 位组件）。

## 四项检测

进程、虚拟机、外设和活动窗口检测改用随安装包提供的 `resources/security/inventory-probe.exe`。这些检查不再启动 PowerShell、不再依赖 WMI 服务，也不需要临时编译 .NET 代码。

- 进程：读取进程快照及可执行文件路径；无法读取路径的受保护进程仍保留在列表中，不会被静默放行。进程白名单仍按路径、签名或指定文件哈希验证。
- 虚拟机：读取 SMBIOS 的系统厂商和型号，必要时读取 BIOS 注册表信息；识别 VMware、VirtualBox、Hyper-V 等型号。普通电脑支持硬件虚拟化不等于运行在虚拟机中。
- 外设：只读取系统当前连接的设备，使用物理 USB 设备实例身份生成指纹。
- 活动窗口：直接读取前台窗口；切换时短暂没有前台窗口或窗口标题为空，不再被误判为权限不可用。

组件只使用 Windows 7 已支持的系统接口，不安装驱动、不禁用设备、不删除设备、不结束进程。检测失败会显示“检测失败”及对应提示，不会显示为已授权，也不会自动跳过检查。管理员权限要求保持生效。

接口兼容性依据：[进程路径](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew)、[当前设备枚举](https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdigetclassdevsw)、[SMBIOS](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemfirmwaretable)、[前台窗口](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow)。

## 外设误报防护

1. 排除已断开的历史设备、USB 根控制器、音视频软件端点和复合设备的子接口。
2. 不使用设备显示名称、驱动名称、设备排序、重复条目或大小写生成指纹。
3. 同一变化必须在两次成功扫描中一致，且间隔至少一秒，才更新指纹；重叠请求只算一次扫描。
4. 扫描失败或报告不完整不会被视为“所有设备被拔掉”，并会清除尚未确认的变化。
5. 登录前确认当前设备基线。升级到 `usb-v4` 时，后台仅在原始基线未发生变化且未锁屏的会话中迁移基线，避免检测格式升级造成误锁；同版本的真实插拔仍触发外设告警和锁屏。

建议在考生登录前接好需要的键盘、鼠标、摄像头等设备。考试中确实插拔物理 USB 设备仍属于外设变化，需要监考老师处理。

## 验证范围

自动检查覆盖两种架构的组件校验、Windows 7 系统 DLL 依赖、硬件报告解析、虚拟机型号、空窗口标题、设备抖动和真实插拔、重叠扫描、失败报告、登录基线及后台升级迁移。安装包还需检查两种架构的实际内嵌文件。

上述代码及安装包检查不能替代真实 Windows 7 电脑的现场复测。在 Windows 7 上安装新版后，重新检测四项状态，并确认考试中插拔外设的告警行为；若某项仍失败，可查看客户端启动诊断日志，检查安全软件是否隔离了检测组件。
