# Kingdom Life Study — web edition

The Kingdom Life Study app, served as a website at <https://app.kingdom-life-ministry.com>.

**This folder is generated. Do not edit it by hand.** It is rebuilt from
`app/www` by `pipeline/build_web.py`; anything changed here is lost on the next
build. Fix the app in `app/www` and the concordance, reader and library change
in the Android app and on the web at the same time.

## Publishing

```powershell
cd C:\Users\micha\Downloads\Jeremiah_Study_Guide
python pipeline\build_web.py
cd web
git add -A
git commit -m "rebuild"
git push
```

GitHub Pages redeploys in a minute or two. Readers get the new build the next
time they open the app, with a card offering to reload.

See `WEB_PUBLISHING.md` in the parent folder for the full setup.
