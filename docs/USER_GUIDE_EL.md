# TabSpace — εγκατάσταση, ενημέρωση και helper

## Ποιο αρχείο χρειάζομαι;

- **TabSpace-0.18.4.zip** — το extension, χωρίς αλλαγή της σελίδας νέας καρτέλας του Chrome.
- **DragGroup-Helper-Setup-1.0.0.exe** — προαιρετικός installer helper για το ενσωματωμένο ή το standalone Drag Group.
- **TabSpace-SHA256SUMS.txt** — checksums των δύο downloads.

Κατέβασε τα αρχεία από το [release του TabSpace](https://github.com/Kechos23/TabSpace/releases/tag/tabspace-v0.18.4). Οι οδηγοί και οι έλεγχοι συνδέονται από την περιγραφή του release. Οι άδειες και τα third-party notices περιλαμβάνονται ήδη στα πακέτα.

## Εγκατάσταση TabSpace

1. Αποσυμπίεσε το ZIP σε μόνιμο φάκελο, π.χ. `C:\Apps\TabSpace\extension`. Το `manifest.json` πρέπει να βρίσκεται απευθείας εκεί.
2. Στο `chrome://extensions`, ενεργοποίησε Developer mode, πάτησε **Load unpacked** και διάλεξε τον φάκελο. Δεν είναι εγκατάσταση μέσω Chrome Web Store.
3. Από το εικονίδιο άνοιξε **Open manager** ή **Open side panel**. Ο organizer δεν χρειάζεται helper ή cloud λογαριασμό.
4. Τα νέα κανονικά παράθυρα έχουν Unsaved Spaces. Κάνε Save Space για μόνιμη οργάνωση. Τα Resources παραμένουν ανεξάρτητα από τις ανοιχτές καρτέλες. Το Inbox κρατά links, notes και προσωπικά tasks.

Στο **Settings → Manager → Keep a pinned manager in every window** μπορείς να διατηρείς αυτόματα τον manager χωρίς Drag Group. Αρχικά είναι κλειστό. Το ενεργό Drag Group επίσης κρατά τον απαραίτητο pinned manager· οι δύο επιλογές μοιράζονται έναν ανά κανονικό παράθυρο. Η σελίδα νέας καρτέλας του Chrome παραμένει όπως ήταν.

## Προαιρετικό Drag Group

1. Κάνε pause το Drag Group ή κλείσε εντελώς τον Chrome. Για την ενσωματωμένη έκδοση, απενεργοποίησε πρώτα το standalone extension αν υπάρχει.
2. Τρέξε το **DragGroup-Helper-Setup-1.0.0.exe**. Ο wizard εγκαθιστά τον helper στον χρήστη σου, στο `%LocalAppData%\TabSpace\DragGroupHelper`, χωρίς εντολές PowerShell.
3. Αν λείπει το **.NET 10 Desktop Runtime x64**, πάτησε **Get .NET from Microsoft**, εγκατέστησε το x64 Desktop Runtime και μετά **Check again**. Ο installer του runtime μπορεί να ζητήσει administrator· ο installer του helper δεν χρειάζεται.
4. Αν βρεθεί παλιά portable καταχώριση, επιβεβαίωσε την αντικατάστασή της. Ο παλιός φάκελος διατηρείται και κρατούνται στοιχεία επαναφοράς. Το Setup δεν έχει ακόμη ψηφιακή υπογραφή.
5. Ενεργοποίησε το Drag Group στο TabSpace Settings ή στο standalone popup, δώσε την προαιρετική άδεια helper και έλεγξε το status. Χρησιμοποίησε μία ενεργή έκδοση κάθε φορά.

Δεν εγκαθίσταται service ή εργασία εκκίνησης. Με δύο unpinned και ungrouped καρτέλες στο ίδιο παράθυρο, σύρε τη μία πάνω στην άλλη: με επικάλυψη 16% και αναμονή 200 ms εμφανίζεται η ένδειξη· άφησε για grouping ή μετακίνησε πίσω για ακύρωση. Τα πλήρη όρια περιγράφονται στο [Known limitations](KNOWN_LIMITATIONS.md).

## Standalone Drag Group

Κατέβασε το **DragGroup-0.1.21.zip** από το standalone release και κάνε Load unpacked τον αποσυμπιεσμένο φάκελο που περιέχει το `manifest.json`. Εγκατέστησε μία φορά τον κοινό **Setup.exe** και κράτα απενεργοποιημένο το Drag Group μέσα στο TabSpace. Η standalone έκδοση χρησιμοποιεί δικό της pinned controller.

## Ενημέρωση, repair και επαναφορά

1. Κράτα ανεξάρτητο JSON/ZIP export από Settings → Backup & Recovery. Το sync δεν αντικαθιστά το backup.
2. Διατήρησε τον υπάρχοντα φάκελο και την εγκατάσταση του extension, ενημέρωσε τα αρχεία από το ZIP και πάτησε **Reload**. Μην κάνεις Remove για ενημέρωση: διαγράφει τα ενεργά τοπικά δεδομένα.
3. Για update ή repair του διαχειριζόμενου helper, κάνε pause το Drag Group ή κλείσε τον Chrome και ξανατρέξε το Setup. Αρνείται αλλαγές όσο ο helper χρησιμοποιείται.
4. Για αφαίρεση πήγαινε **Windows Settings → Apps → Drag Group Helper → Uninstall**. Η προηγούμενη portable καταχώριση επανέρχεται μόνο αν υπάρχει ακόμη το παλιό manifest και η τωρινή καταχώριση ανήκει στον installer. Κράτα τον παλιό φάκελο αν θέλεις επιστροφή. Καταχώριση που ανήκει σε άλλη εγκατάσταση παραμένει ανέπαφη.
5. Κάνε Reload και έλεγξε το status. Ένας ήδη λειτουργικός helper 0.1.21 δεν χρειάζεται ενημέρωση μόνο για τον pinned manager. Μελλοντικό downgrade του extension χρειάζεται συμβατό schema και backup.

## Προαιρετικός συγχρονισμός

Στο Settings → Cloud sync δήλωσε Nextcloud address, username, App password και ίδιο Sync folder σε κάθε PC. Διάλεξε ξεχωριστό **Sync password** τουλάχιστον 12 χαρακτήρων και κράτησέ το ασφαλές. Στο δεύτερο PC χρειάζεσαι το ίδιο password και φάκελο. Το TabSpace δεν μπορεί να ανακτήσει χαμένο Sync password. Μετά από επανεκκίνηση Chrome χρειάζεται Unlock.

Συγχρονίζονται Saved Spaces και περιεχόμενο, Inbox και Collections. Unsaved Spaces, ανοιχτά παράθυρα και τοπικές προτιμήσεις μένουν στη συσκευή. Το popup δείχνει κατάσταση και τελευταίο επιτυχημένο sync· Ready δεν σημαίνει ότι έχουν ανέβει όλες οι αλλαγές. Αναλυτικά: [οδηγός sync](CLOUD_SYNC.md).

## Αφαίρεση

Κράτα export, κάνε pause το Drag Group και αφαίρεσε τον διαχειριζόμενο helper από τα **Windows Settings → Apps**. Αν χρησιμοποιείς ακόμη παλιά portable εγκατάσταση, τρέξε το δικό της `Uninstall.ps1 -Apply` πριν σβήσεις τον φάκελο. Το Remove του Chrome extension διαγράφει τα ενεργά τοπικά του δεδομένα. Το Disconnect του sync δεν διαγράφει τα cloud δεδομένα.
