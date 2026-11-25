# Windows 7 系统与 USB 检测

`inventory-probe.exe` 提供只读 `processes`、`peripherals`、`hardware` 、`window` 和 `peripheral-events <父进程PID>` 子命令。
同时维护 `ia32` 和 `x64` 可执行文件，不依赖 PowerShell、WMI 服务或额外的 C 运行时。
修改源码后运行 `node scripts/prepare-windows-inventory.mjs --rebuild`；普通构建校验源码与两个产物的 SHA-256。

USB 清单使用 `DIGCF_PRESENT` 排除离线历史设备，并返回设备实例 ID、总线类型和硬件 ID。
Windows 7 上的厂商驱动可能使用自己的枚举器名称，因此不能仅匹配实例 ID 的 `USB\` 前缀。
总线 GUID / 硬件 ID 补足这些设备的识别，同时排除根集线器、复合设备 `MI_xx` 接口和 HID / 存储子节点。
指纹版本为 `usb-v6`：统一物理设备的 VID/PID 与实例身份，忽略厂商枚举器名称和 REV 元数据；另行排除 SCSI、STORAGE、ROOT 等子节点。升级后的既有会话需要服务端执行一次格式迁移。

整个原生报告先缓冲再写入管道，避免逐字节 `WriteFile` 对旧机器造成的开销。
桌面通过独立 USB IPC 获取报告，进程签名或窗口检测的慢响应及失败不会丢弃 USB 检测结果。
探针失败、输出不完整或报告过期会显式上报 `peripheralScanOk: false`，不再把旧指纹当作本次正常检测。

## 验证

自动测试覆盖两种 PE 架构、Windows 7 子系统版本与系统 DLL 导入，源码/产物校验，原生缓冲器的边界与字节一致性，以及第三方总线、复合设备、插拔确认、故障和独立快照生命周期。

发布前仍须在真实 Windows 7 SP1 32 位与 64 位机器上验证：

1. 启动对应架构的 `inventory-probe.exe peripherals`，确认键盘、鼠标、U 盘、USB 集线器等实际设备及厂商 USB 3 控制器有报告。
2. 同一设备集合连续运行两次，除顺序外应保持一致；接入或移除设备后报告应相应变化。开启摄像头 / 音频不应增加物理设备。
3. 考试中持续接入 / 移除设备至少两个扫描周期，确认后台告警与锁定；监考员解锁后以当前设备集合继续。
4. 模拟检测组件缺失 / 被隔离、权限读取失败和其他安全探针失败，分别确认外设故障被报告，以及正常 USB 检测不被无关故障阻断。

Windows 另外使用 `RegisterDeviceNotification` 订阅 `GUID_DEVINTERFACE_USB_DEVICE` 的接口通知。首次启动监听时，如果本机已确认的登录设备清单与会话基线指纹一致，就以这份清单为基准核对启动时的设备。通知到达后会尽快安排首次扫描，并在 1.5 秒后复核变化或检查尚未更新的清单。变化至少持续 3 秒且多次观察一致后才生成持久插拔事件。指纹轮询使用相同的确认间隔，并与监听复用正在执行的原生扫描。
已存在设备的重复接入通知、物理节点仍存在时的接口停用、确认窗口内恢复的同一设备均不会生成插拔事件。无摄像头电脑同样适用。
新身份设备短时接入后移除时，只有清单先观察到设备存在，随后在移除通知后确认已不存在，才会上报两条事件。清单从未观察到的接口启停不触发锁定。已知设备在确认窗口内恢复时会过滤，持续缺失仍触发检测。同一考试会话内监听重启后继续比对上次确认的设备清单。
过滤 `MI_xx` 复合接口、HID / 音频等软件子设备。诊断日志新增 `usb-events`，记录监听基线、忽略的接口抖动、已确认变化与探针/监听故障。
通知进程跟随父进程退出；队列有容量上限，监听失败显式上报检测不可用。
当前开发环境没有 Windows 7 真机，交叉编译、通知夹具与单元测试不能代替上面的实测。

微软接口文档：

- [SetupDiGetClassDevs / DIGCF_PRESENT](https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdigetclassdevsa)
- [SetupDiGetDeviceRegistryProperty / 总线与硬件 ID](https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdigetdeviceregistrypropertyw)
- [USB 物理设备与复合设备接口标识](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/standard-usb-identifiers)
