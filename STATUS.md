# סטטוס הפרויקט

- **עודכן:** 2026-10-10.
- **השלב:** הניסוי הטכני 01 בביצוע.

## איך ממשיכים מכאן

- **קודם כול:** קוראים את המסמך הזה.
- **במחשב חדש, פעם אחת:**
  - משכפלים את ה־`repo` ועוברים ל־`branch` של הניסוי: `git clone https://github.com/DanielShapi4a/coupon-wallet`, ואחריו `git switch spike/key-recovery`.
  - מגדירים זהות `git` שמקושרת לחשבון ה־`GitHub`, בתוך התיקייה של ה־`repo`: `git config user.name "Daniel Shapira"`, ואחריו `git config user.email "116350669+DanielShapi4a@users.noreply.github.com"`.
  - בתיקייה `spikes/key-recovery` מריצים `npm ci`. אם `npm` חוסם את ה־`postinstall` של `react-native-libsodium`, מאשרים אותו עם `npm install-scripts approve react-native-libsodium`, ומריצים `npm rebuild react-native-libsodium`.
  - מתחברים ל־`Expo` עם `npx eas-cli login`.
- **כשצריך הקשר:** [docs/README.md](docs/README.md) מפנה לכל המסמכים. כל ההחלטות נמצאות ב־[docs/decision-log.md](docs/decision-log.md).
- **בסוף כל סשן:** מעדכנים את המסמך הזה.

## מה הושלם

- **שלב הגילוי:**
  - חזון ועקרונות.
  - ראיות מהשטח.
  - ניתוח מתחרים.
  - מודל `domain`.
- **`PRD` לשלב 1:** גרסת הבודקים.
- **`ADR-001`, ניהול מפתחות:** מקובל בכפוף לניסוי הטכני.
- **ארכיטקטורה:** כולל סקירה ספקנית, שששת התיקונים שלה אושרו (החלטה 033).
- **יומן ההחלטות:** 33 החלטות.
- **`repo`:** https://github.com/DanielShapi4a/coupon-wallet. במחשב הזה הוא נמצא ב־`C:\git\coupon-wallet`.

## הצעדים הבאים

- **ניסוי טכני 01, בביצוע:**
  - **איפה:** ב־`branch` בשם `spike/key-recovery`.
  - **התוכנית והשלבים:** `docs/spikes/spike-01-key-recovery.md`, באותו `branch`.
  - **מה כבר נעשה:**
    - הבנייה הראשונה ב־`EAS` הצליחה, וקובץ ה־`APK` מותקן בטלפון.
    - נפתח `repo` בשם `danielshapi4a.github.io`, שיחזיק את `assetlinks.json`.
  - **השלב הבא, במחשב האישי:**
    - מריצים `npx expo start --tunnel` בתיקייה `spikes/key-recovery`, ומחברים את הטלפון.
    - בודקים את כפתורים 1, 2a ו־2b.
    - מוציאים את ה־`SHA-256` של מפתח החתימה בעזרת `npx eas-cli credentials -p android`, ומפרסמים את `assetlinks.json`.
  - קוד זמני, שנזרק אחרי הבדיקה. מה בודקים:
  - `passkey` עם הרחבת `PRF`. זה המועמד הראשון לשחזור.
  - `Block Store`: שחזור אמיתי, והתקנה מחדש באותו טלפון.
  - ספרייה של `libsodium` שעובדת עם `Expo`.
  - התראות `FCM` בלי תוכן.
  - מה קורה כשמתחברים לאפליקציה עם חשבון `Google` אחר מזה שמגבה את הטלפון.
  - **מה צריך:** טלפון `Android`, וטלפון שני לבדיקת שחזור.
- **`threat-model.md`:** בשיטת `STRIDE`.
- **`ADR-002`:** פרטי הטכנולוגיה.
- **`ADR-003`:** אירוח. `AWS` הוא המועמד הטבעי (החלטה 032).
- **אחר כך:** תכנון המימוש.

## שאלות פתוחות

- **שחזור:** `passkey` או `Block Store`. הניסוי יכריע, וההעדפה היא `passkey` אם הוא עובד.
- **שם האפליקציה.**
- **גרסת `Android` המינימלית:** תיקבע ב־`ADR`.
- **מודל הכנסה:** בהמשך.

## עובדות שכדאי לזכור

- **בודקים:** יהיו רק 2 עד 3 (החלטה 026).
- **עדיפויות של המשתמש:**
  - פשטות למשתמש הקצה, ושום דבר חדש לזכור (החלטה 029).
  - שירותים גדולים ומנוהלים (החלטה 032).
- **אופן העבודה:** מתואר ב־[CLAUDE.md](CLAUDE.md).
