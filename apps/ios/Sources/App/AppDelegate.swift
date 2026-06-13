import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        MobileTelemetry.sync()
        UNUserNotificationCenter.current().delegate = self
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(requestRemoteNotificationRegistration),
            name: .shellyShouldRegisterForRemoteNotifications,
            object: nil
        )
        return true
    }

    @objc private func requestRemoteNotificationRegistration() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else {
                return
            }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationCenter.default.post(name: .shellyDidRegisterApnsToken, object: deviceToken)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let sessionIdHash = userInfo["session_id_hash"] as? String else {
            return
        }
        NotificationCenter.default.post(name: .shellyDidReceivePushSessionHash, object: sessionIdHash)
    }
}

extension Notification.Name {
    static let shellyShouldRegisterForRemoteNotifications = Notification.Name("shellyShouldRegisterForRemoteNotifications")
    static let shellyDidRegisterApnsToken = Notification.Name("shellyDidRegisterApnsToken")
    static let shellyDidReceivePushSessionHash = Notification.Name("shellyDidReceivePushSessionHash")
}
