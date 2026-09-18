2026-09-18T21:10:36.5043558Z Current runner version: '2.337.0'
2026-09-18T21:10:36.5069368Z ##[group]Runner Image Provisioner
2026-09-18T21:10:36.5070465Z Hosted Compute Agent
2026-09-18T21:10:36.5071139Z Version: 20260828.587
2026-09-18T21:10:36.5072026Z Commit: abac92662cab4cc7352de4f9f9d2e2419aad9c29
2026-09-18T21:10:36.5072923Z Build Date: 2026-08-28T16:44:25Z
2026-09-18T21:10:36.5074118Z Worker ID: {53999b47-10d5-4fb2-ad28-90e3055ec5a0}
2026-09-18T21:10:36.5074944Z Azure Region: westus
2026-09-18T21:10:36.5075622Z ##[endgroup]
2026-09-18T21:10:36.5077436Z ##[group]Operating System
2026-09-18T21:10:36.5078301Z Ubuntu
2026-09-18T21:10:36.5078931Z 24.04.5
2026-09-18T21:10:36.5079495Z LTS
2026-09-18T21:10:36.5080168Z ##[endgroup]
2026-09-18T21:10:36.5080799Z ##[group]Runner Image
2026-09-18T21:10:36.5081554Z Image: ubuntu-24.04
2026-09-18T21:10:36.5082660Z Version: 20260907.300.1
2026-09-18T21:10:36.5084234Z Included Software: https://github.com/actions/runner-images/blob/ubuntu24/20260907.300/images/ubuntu/Ubuntu2404-Readme.md
2026-09-18T21:10:36.5085978Z Image Release: https://github.com/actions/runner-images/releases/tag/ubuntu24%2F20260907.300
2026-09-18T21:10:36.5087022Z ##[endgroup]
2026-09-18T21:10:36.5088372Z ##[group]GITHUB_TOKEN Permissions
2026-09-18T21:10:36.5090694Z Contents: write
2026-09-18T21:10:36.5091412Z Metadata: read
2026-09-18T21:10:36.5092000Z ##[endgroup]
2026-09-18T21:10:36.5094627Z Secret source: Actions
2026-09-18T21:10:36.5095819Z Cache mode: write
2026-09-18T21:10:36.5096675Z Prepare workflow directory
2026-09-18T21:10:36.5438932Z Prepare all required actions
2026-09-18T21:10:36.5489151Z Getting action download info
2026-09-18T21:10:36.9124390Z Download action repository 'actions/checkout@v4' (SHA:11d5960a326750d5838078e36cf38b85af677262)
2026-09-18T21:10:37.1306736Z Complete job name: build
2026-09-18T21:10:37.2083740Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
2026-09-18T21:10:37.2092605Z ##[group]Run actions/checkout@v4
2026-09-18T21:10:37.2093992Z with:
2026-09-18T21:10:37.2094603Z   repository: freshdewsteam/South-Streams
2026-09-18T21:10:37.2098485Z   token: ***
2026-09-18T21:10:37.2099119Z   ssh-strict: true
2026-09-18T21:10:37.2099600Z   ssh-user: git
2026-09-18T21:10:37.2100091Z   persist-credentials: true
2026-09-18T21:10:37.2100640Z   clean: true
2026-09-18T21:10:37.2101146Z   sparse-checkout-cone-mode: true
2026-09-18T21:10:37.2101704Z   fetch-depth: 1
2026-09-18T21:10:37.2102181Z   fetch-tags: false
2026-09-18T21:10:37.2102658Z   show-progress: true
2026-09-18T21:10:37.2103145Z   lfs: false
2026-09-18T21:10:37.2104356Z   submodules: false
2026-09-18T21:10:37.2104905Z   set-safe-directory: true
2026-09-18T21:10:37.2105469Z   allow-unsafe-pr-checkout: false
2026-09-18T21:10:37.2106436Z ##[endgroup]
2026-09-18T21:10:37.3175586Z Syncing repository: freshdewsteam/South-Streams
2026-09-18T21:10:37.3178661Z ##[group]Getting Git version info
2026-09-18T21:10:37.3179550Z Working directory is '/home/runner/work/South-Streams/South-Streams'
2026-09-18T21:10:37.3180772Z [command]/usr/bin/git version
2026-09-18T21:10:37.3308988Z git version 2.55.0
2026-09-18T21:10:37.3332929Z ##[endgroup]
2026-09-18T21:10:37.3353713Z Temporarily overriding HOME='/home/runner/work/_temp/a2e74ec4-5907-4277-bb89-5e30f74ae137' before making global git config changes
2026-09-18T21:10:37.3356424Z Adding repository directory to the temporary git global config as a safe directory
2026-09-18T21:10:37.3359874Z [command]/usr/bin/git config --global --add safe.directory /home/runner/work/South-Streams/South-Streams
2026-09-18T21:10:37.3418502Z Deleting the contents of '/home/runner/work/South-Streams/South-Streams'
2026-09-18T21:10:37.3423059Z ##[group]Initializing the repository
2026-09-18T21:10:37.3428932Z [command]/usr/bin/git init /home/runner/work/South-Streams/South-Streams
2026-09-18T21:10:37.3565120Z hint: Using 'master' as the name for the initial branch. This default branch name
2026-09-18T21:10:37.3567389Z hint: will change to "main" in Git 3.0. To configure the initial branch name
2026-09-18T21:10:37.3569815Z hint: to use in all of your new repositories, which will suppress this warning,
2026-09-18T21:10:37.3571594Z hint: call:
2026-09-18T21:10:37.3572541Z hint:
2026-09-18T21:10:37.3574421Z hint: 	git config --global init.defaultBranch <name>
2026-09-18T21:10:37.3575704Z hint:
2026-09-18T21:10:37.3576946Z hint: Names commonly chosen instead of 'master' are 'main', 'trunk' and
2026-09-18T21:10:37.3579252Z hint: 'development'. The just-created branch can be renamed via this command:
2026-09-18T21:10:37.3580714Z hint:
2026-09-18T21:10:37.3581547Z hint: 	git branch -m <name>
2026-09-18T21:10:37.3582553Z hint:
2026-09-18T21:10:37.3584080Z hint: Disable this message with "git config set advice.defaultBranchName false"
2026-09-18T21:10:37.3586128Z Initialized empty Git repository in /home/runner/work/South-Streams/South-Streams/.git/
2026-09-18T21:10:37.3589324Z [command]/usr/bin/git remote add origin https://github.com/freshdewsteam/South-Streams
2026-09-18T21:10:37.3647254Z ##[endgroup]
2026-09-18T21:10:37.3648152Z ##[group]Disabling automatic garbage collection
2026-09-18T21:10:37.3655111Z [command]/usr/bin/git config --local gc.auto 0
2026-09-18T21:10:37.3702476Z ##[endgroup]
2026-09-18T21:10:37.3704765Z ##[group]Setting up auth
2026-09-18T21:10:37.3714292Z [command]/usr/bin/git config --local --name-only --get-regexp core\.sshCommand
2026-09-18T21:10:37.3752919Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'core\.sshCommand' && git config --local --unset-all 'core.sshCommand' || :"
2026-09-18T21:10:37.4147195Z [command]/usr/bin/git config --local --name-only --get-regexp http\.https\:\/\/github\.com\/\.extraheader
2026-09-18T21:10:37.4184187Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'http\.https\:\/\/github\.com\/\.extraheader' && git config --local --unset-all 'http.https://github.com/.extraheader' || :"
2026-09-18T21:10:37.4419294Z [command]/usr/bin/git config --local --name-only --get-regexp ^includeIf\.gitdir:
2026-09-18T21:10:37.4458472Z [command]/usr/bin/git submodule foreach --recursive git config --local --show-origin --name-only --get-regexp remote.origin.url
2026-09-18T21:10:37.4707040Z [command]/usr/bin/git config --local http.https://github.com/.extraheader AUTHORIZATION: basic ***
2026-09-18T21:10:37.4754317Z ##[endgroup]
2026-09-18T21:10:37.4756220Z ##[group]Fetching the repository
2026-09-18T21:10:37.4766150Z [command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +76a21238c7becff10cb23129cf25011fe26e3546:refs/remotes/origin/main
2026-09-18T21:10:37.9157957Z From https://github.com/freshdewsteam/South-Streams
2026-09-18T21:10:37.9160709Z  * [new ref]         76a21238c7becff10cb23129cf25011fe26e3546 -> origin/main
2026-09-18T21:10:37.9167209Z ##[endgroup]
2026-09-18T21:10:37.9169832Z ##[group]Determining the checkout info
2026-09-18T21:10:37.9172529Z ##[endgroup]
2026-09-18T21:10:37.9177772Z [command]/usr/bin/git sparse-checkout disable
2026-09-18T21:10:37.9237283Z [command]/usr/bin/git config --local --unset-all extensions.worktreeConfig
2026-09-18T21:10:37.9274001Z ##[group]Checking out the ref
2026-09-18T21:10:37.9278301Z [command]/usr/bin/git checkout --progress --force -B main refs/remotes/origin/main
2026-09-18T21:10:37.9353061Z Switched to a new branch 'main'
2026-09-18T21:10:37.9358365Z branch 'main' set up to track 'origin/main'.
2026-09-18T21:10:37.9368458Z ##[endgroup]
2026-09-18T21:10:37.9410970Z [command]/usr/bin/git log -1 --format=%H
2026-09-18T21:10:37.9438073Z 76a21238c7becff10cb23129cf25011fe26e3546
2026-09-18T21:10:37.9692144Z ##[group]Run npm run build
2026-09-18T21:10:37.9692888Z [36;1mnpm run build[0m
2026-09-18T21:10:37.9734418Z shell: /usr/bin/bash -e {0}
2026-09-18T21:10:37.9735341Z env:
2026-09-18T21:10:37.9736038Z   TMDB_API_KEY: ***
2026-09-18T21:10:37.9736612Z   OMDB_API_KEY: ***
2026-09-18T21:10:37.9737712Z   GOOGLE_SHEET_URL: ***
2026-09-18T21:10:37.9738966Z   WEBHOOK_URL: ***
2026-09-18T21:10:37.9739658Z   MON_API_KEY: ***
2026-09-18T21:10:37.9740263Z   SCRAPERAPI_KEY: ***
2026-09-18T21:10:37.9740804Z ##[endgroup]
2026-09-18T21:10:41.8176225Z 
2026-09-18T21:10:41.8176956Z > south-streams@1.6.3 build
2026-09-18T21:10:41.8177783Z > node scripts/build-cache.js
2026-09-18T21:10:41.8178244Z 
2026-09-18T21:10:41.9264456Z === Building South Streams Cache ===
2026-09-18T21:10:41.9267622Z Time: 2026-09-18T21:10:41.926Z
2026-09-18T21:10:41.9268457Z 
2026-09-18T21:10:41.9268692Z [1/4] Malayalam movies...
2026-09-18T21:10:41.9271069Z [Cache] Movies: 0 entries
2026-09-18T21:10:41.9297583Z [Cache] Series: 1228 entries
2026-09-18T21:10:46.2379867Z [Rate] Pausing 11s...
2026-09-18T21:10:58.9127886Z [Rate] Pausing 14s...
2026-09-18T21:11:14.6675791Z [Rate] Pausing 13s...
2026-09-18T21:11:29.5933381Z [Rate] Pausing 13s...
2026-09-18T21:11:44.9862373Z [Rate] Pausing 13s...
2026-09-18T21:11:59.9389073Z [Rate] Pausing 13s...
2026-09-18T21:12:15.1464945Z [Rate] Pausing 13s...
2026-09-18T21:12:30.0113458Z [Rate] Pausing 13s...
2026-09-18T21:12:45.4135424Z [Rate] Pausing 13s...
2026-09-18T21:12:59.0698442Z [Movies] ml: 6 in catalogue
2026-09-18T21:12:59.0726925Z [Cache] Saved 279 movies, 1228 series
2026-09-18T21:12:59.0728324Z ✅ Done: 6 items
2026-09-18T21:12:59.0729064Z 
2026-09-18T21:12:59.0729538Z [2/4] Malayalam series...
2026-09-18T21:12:59.0730604Z [Cache] Movies: 279 entries
2026-09-18T21:12:59.0748968Z [Cache] Series: 1228 entries
2026-09-18T21:13:04.0931267Z [Rate] Pausing 9s...
2026-09-18T21:13:13.8870394Z [Rate] Pausing 15s...
2026-09-18T21:13:28.7754676Z [Rate] Pausing 15s...
2026-09-18T21:13:43.8166907Z [Rate] Pausing 15s...
2026-09-18T21:13:58.6874625Z [Series] ml: 18 in catalogue
2026-09-18T21:13:58.6897759Z [Cache] Saved 279 movies, 1228 series
2026-09-18T21:13:58.6898798Z ✅ Done: 18 items
2026-09-18T21:13:58.6904326Z 
2026-09-18T21:13:58.6904780Z [3/4] Tamil movies...
2026-09-18T21:13:58.6905572Z [Cache] Movies: 279 entries
2026-09-18T21:13:58.6924388Z [Cache] Series: 1228 entries
2026-09-18T21:14:01.4731266Z [Rate] Pausing 12s...
2026-09-18T21:14:13.7258373Z [Rate] Pausing 15s...
2026-09-18T21:14:29.0171459Z [Rate] Pausing 15s...
2026-09-18T21:14:43.8853045Z [Rate] Pausing 15s...
2026-09-18T21:14:58.9876019Z [Rate] Pausing 15s...
2026-09-18T21:15:14.5722465Z [Rate] Pausing 15s...
2026-09-18T21:15:29.3390859Z [Rate] Pausing 15s...
2026-09-18T21:15:44.4580624Z [Rate] Pausing 15s...
2026-09-18T21:15:59.6387437Z [Rate] Pausing 15s...
2026-09-18T21:16:14.8531215Z [Movies] ta: 12 in catalogue
2026-09-18T21:16:14.8552403Z [Cache] Saved 559 movies, 1228 series
2026-09-18T21:16:14.8554265Z ✅ Done: 12 items
2026-09-18T21:16:14.8554855Z 
2026-09-18T21:16:14.8555083Z [4/4] Tamil series...
2026-09-18T21:16:14.8561599Z [Cache] Movies: 559 entries
2026-09-18T21:16:14.8576596Z [Cache] Series: 1228 entries
2026-09-18T21:16:14.9060877Z [Rate] Pausing 15s...
2026-09-18T21:16:34.3058905Z [Rate] Pausing 11s...
2026-09-18T21:16:45.5959507Z [Rate] Pausing 15s...
2026-09-18T21:17:00.4913874Z [Series] ta: 80 in catalogue
2026-09-18T21:17:00.4941000Z [Cache] Saved 559 movies, 1228 series
2026-09-18T21:17:00.4942062Z ✅ Done: 80 items
2026-09-18T21:17:00.4947536Z 
2026-09-18T21:17:00.4948204Z ✅ Cache saved to: /home/runner/work/South-Streams/South-Streams/data/cache.json
2026-09-18T21:17:00.4949139Z 📊 Summary:
2026-09-18T21:17:00.4949622Z    Malayalam Movies: 6
2026-09-18T21:17:00.4949888Z    Malayalam Series: 18
2026-09-18T21:17:00.4950154Z    Tamil Movies:     12
2026-09-18T21:17:00.4950405Z    Tamil Series:     80
2026-09-18T21:17:00.5156489Z ##[group]Run git config user.name "github-actions[bot]"
2026-09-18T21:17:00.5156962Z [36;1mgit config user.name "github-actions[bot]"[0m
2026-09-18T21:17:00.5157502Z [36;1mgit config user.email "41898282+github-actions[bot]@users.noreply.github.com"[0m
2026-09-18T21:17:00.5158206Z [36;1mgit add data/[0m
2026-09-18T21:17:00.5158488Z [36;1mif git diff --staged --quiet; then[0m
2026-09-18T21:17:00.5158814Z [36;1m  echo "No cache changes to commit"[0m
2026-09-18T21:17:00.5159113Z [36;1melse[0m
2026-09-18T21:17:00.5159416Z [36;1m  git commit -m "chore: refresh OTT catalog cache [skip ci]"[0m
2026-09-18T21:17:00.5159786Z [36;1m  git push[0m
2026-09-18T21:17:00.5160010Z [36;1mfi[0m
2026-09-18T21:17:00.5197835Z shell: /usr/bin/bash -e {0}
2026-09-18T21:17:00.5198111Z ##[endgroup]
2026-09-18T21:17:00.5449844Z [main 4b1e8af] chore: refresh OTT catalog cache [skip ci]
2026-09-18T21:17:00.5450634Z  3 files changed, 2604 insertions(+), 223 deletions(-)
2026-09-18T21:17:01.8690022Z To https://github.com/freshdewsteam/South-Streams
2026-09-18T21:17:01.8690525Z    76a2123..4b1e8af  main -> main
2026-09-18T21:17:01.8851352Z Node 20 is being deprecated. This workflow is running with Node 24 by default. If you need to temporarily use Node 20, you can set the ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION=true environment variable. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
2026-09-18T21:17:01.8852938Z Post job cleanup.
2026-09-18T21:17:01.9722067Z [command]/usr/bin/git version
2026-09-18T21:17:01.9772945Z git version 2.55.0
2026-09-18T21:17:01.9818423Z Temporarily overriding HOME='/home/runner/work/_temp/bff06904-1d7f-4c3e-be24-14ed9371796b' before making global git config changes
2026-09-18T21:17:01.9819801Z Adding repository directory to the temporary git global config as a safe directory
2026-09-18T21:17:01.9825464Z [command]/usr/bin/git config --global --add safe.directory /home/runner/work/South-Streams/South-Streams
2026-09-18T21:17:01.9867758Z [command]/usr/bin/git config --local --name-only --get-regexp core\.sshCommand
2026-09-18T21:17:01.9904518Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'core\.sshCommand' && git config --local --unset-all 'core.sshCommand' || :"
2026-09-18T21:17:02.0161439Z [command]/usr/bin/git config --local --name-only --get-regexp http\.https\:\/\/github\.com\/\.extraheader
2026-09-18T21:17:02.0191448Z http.https://github.com/.extraheader
2026-09-18T21:17:02.0212229Z [command]/usr/bin/git config --local --unset-all http.https://github.com/.extraheader
2026-09-18T21:17:02.0239770Z [command]/usr/bin/git submodule foreach --recursive sh -c "git config --local --name-only --get-regexp 'http\.https\:\/\/github\.com\/\.extraheader' && git config --local --unset-all 'http.https://github.com/.extraheader' || :"
2026-09-18T21:17:02.0510604Z [command]/usr/bin/git config --local --name-only --get-regexp ^includeIf\.gitdir:
2026-09-18T21:17:02.0562138Z [command]/usr/bin/git submodule foreach --recursive git config --local --show-origin --name-only --get-regexp remote.origin.url
2026-09-18T21:17:02.0976501Z Cleaning up orphan processes
2026-09-18T21:17:02.1270465Z ##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4. For more information see: https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
