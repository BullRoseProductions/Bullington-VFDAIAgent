import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

// FCM WIRING (iOS)
//
// By default @capacitor/push-notifications posts the raw APNs device token to Capacitor, and the JS
// `registration` event hands back a 64-char hex APNs token. Our server sends via FCM, which needs the
// FCM token instead — a different, longer string.
//
// The plugin's handler (PushNotificationsPlugin.swift:184-199) accepts EITHER a Data object (which it
// hex-encodes into the APNs token) OR a String (which it forwards verbatim). So the wiring is:
//   1. hand the APNs token to FirebaseMessaging instead of posting it,
//   2. let Firebase mint the FCM token,
//   3. post THAT string — the plugin forwards it, and src/push.js files it via register_device.
//
// Token refresh fires the same delegate again, which re-posts and re-upserts. That is intended:
// FCM rotates tokens, and a stale one is a silently undelivered notification.
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // FirebaseApp.configure() hard-crashes if GoogleService-Info.plist isn't in the bundle. The plist
        // is added to the target as a separate Xcode step, so guard rather than trap: a build made before
        // that step still launches, just without push.
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            Messaging.messaging().delegate = self
        } else {
            print("[B4C] GoogleService-Info.plist not in the app bundle — Firebase not configured, push disabled.")
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    // APNs handed us a device token. Give it to Firebase and deliberately DO NOT post it onward —
    // posting the Data here is exactly what makes JS receive an APNs token instead of the FCM one.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

extension AppDelegate: MessagingDelegate {
    // Fires once the FCM token exists, and again on every refresh. This is the token the server sends to.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken = fcmToken else {
            NotificationCenter.default.post(
                name: .capacitorDidFailToRegisterForRemoteNotifications,
                object: NSError(domain: "B4C", code: -1,
                                userInfo: [NSLocalizedDescriptionKey: "Firebase returned no FCM token."])
            )
            return
        }
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: fcmToken)
    }
}
