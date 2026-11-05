#![cfg(unix)]
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, process::Command};
use tempfile::TempDir;

struct Fixture {
    dir: TempDir,
    repo: std::path::PathBuf,
    state: std::path::PathBuf,
    program: std::path::PathBuf,
    data: std::path::PathBuf,
    log: std::path::PathBuf,
}

fn git(repo: &std::path::Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn note(id: u64, body: &str) -> Value {
    json!({"id":id,"type":"DiffNote","body":body,"author":{"username":"reviewer"},"updated_at":body,
        "system":false,"resolvable":true,"resolved":false,
        "position":{"new_path":"file.txt","old_path":"file.txt","new_line":2,"old_line":null,"head_sha":"sha1"}})
}
fn discussion(id: &str, notes: Value) -> Value {
    json!({"id":id,"individual_note":false,"notes":notes})
}
fn mr() -> Value {
    json!({"iid":1,"state":"opened","web_url":"https://gitlab.com/group/repo/-/merge_requests/1",
        "source_branch":"feature","target_branch":"main","source_project_id":10,"target_project_id":10,
        "diff_refs":{"head_sha":"sha1"}})
}

const FAKE: &str = r#"#!/usr/bin/env python3
import sys,os,json
a=sys.argv[1:]
with open(os.environ['FAKE_LOG'],'a') as f:f.write(json.dumps(a)+'\n')
d=json.load(open(os.environ['FAKE_DATA']))
if a[0]=='api':
    assert a[1]=='--hostname' and a[3]=='--method'
    host,method,endpoint=a[2],a[4],a[5]
    assert host==d.get('host','gitlab.com'),host
    if d.get('fail'):
        print(d.get('fail_message','glab: 500 Internal Server Error'),file=sys.stderr);sys.exit(1)
    fields=dict(s.split('=',1) for s in a[6:] if s!='-f')
    project=d.get('project','group%2Frepo')
    if method=='POST':
        assert endpoint==f"projects/{project}/merge_requests/1/discussions/d1abc/notes",endpoint
        if d.get('reply_fail'):sys.exit(2)
        n={'id':99,'type':'DiffNote','body':fields['body'],'author':{'username':'me'},'updated_at':'new','system':False,'resolvable':True,'resolved':False,'position':d['discussions'][0]['notes'][0].get('position')}
        d['discussions'][0]['notes'].append(n)
        with open(os.environ['FAKE_DATA'],'w') as f:json.dump(d,f)
        if d.get('reply_lost'):sys.exit(2)
        print(json.dumps(n));sys.exit(0)
    if endpoint==f"projects/{project}/merge_requests":
        assert fields['state']=='opened' and fields['source_branch']=='feature'
        print(json.dumps(d['mrs']));sys.exit(0)
    if endpoint==f"projects/{project}/merge_requests/1":
        print(json.dumps(d['mr']));sys.exit(0)
    if endpoint==f"projects/{project}/merge_requests/1/discussions":
        per,page=int(fields['per_page']),int(fields['page'])
        print(json.dumps(d['discussions'][(page-1)*per:page*per]));sys.exit(0)
    if endpoint.startswith('projects/') and endpoint[9:] in d.get('projects',{}):
        print(json.dumps({'id':d['projects'][endpoint[9:]]}));sys.exit(0)
    print('glab: 404 Not Found',file=sys.stderr);sys.exit(1)
if a[0]=='get':
    print(json.dumps({'state':'live','status':{'state':'idle','app':'opencode'},'foreground':{'cwd':os.environ['FAKE_CWD']}}));sys.exit(0)
if a[0]=='send':
    if d.get('send_fail'):sys.exit(2)
    print(json.dumps({'turn':1,'started':True}));sys.exit(0)
sys.exit(2)
"#;

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--initial-branch=feature"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(
            &repo,
            &["remote", "add", "origin", "git@gitlab.com:group/repo.git"],
        );
        fs::write(repo.join("file.txt"), "old\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        fs::write(repo.join("file.txt"), "new\n").unwrap();
        let state = dir.path().join("state");
        let program = dir.path().join("fake");
        let data = dir.path().join("data.json");
        let log = dir.path().join("calls.jsonl");
        fs::write(&program, FAKE).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            &data,
            json!({"mrs":[{"iid":1}],"mr":mr(),
                "discussions":[discussion("d1abc", json!([note(1, "Please handle the empty input")]))]})
            .to_string(),
        )
        .unwrap();
        Self {
            dir,
            repo,
            state,
            program,
            data,
            log,
        }
    }
    fn request_with(&self, mut value: Value, hosts: &str) -> Value {
        value["scope"] = json!({"repo":self.repo,"machine":null});
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-annotator"))
            .args(["request", &value.to_string()])
            .env("HOME", self.dir.path())
            .env("HERDR_ANNOTATOR_STATE_DIR", &self.state)
            .env("HERDR_ANNOTATOR_GLAB", &self.program)
            .env("HERDR_ANNOTATOR_GH", &self.program)
            .env("HERDR_ANNOTATOR_HC", &self.program)
            .env("HERDR_ANNOTATOR_GITLAB_HOSTS", hosts)
            .env("FAKE_DATA", &self.data)
            .env("FAKE_LOG", &self.log)
            .env("FAKE_CWD", &self.repo)
            .output()
            .unwrap();
        serde_json::from_slice(&out.stdout).unwrap()
    }
    fn request(&self, value: Value) -> Value {
        self.request_with(value, "")
    }
    fn update(&self, f: impl FnOnce(&mut Value)) {
        let mut data: Value = serde_json::from_slice(&fs::read(&self.data).unwrap()).unwrap();
        f(&mut data);
        fs::write(&self.data, data.to_string()).unwrap();
    }
    fn calls(&self, op: &str) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|v| v[0] == op)
            .collect()
    }
    fn posts(&self) -> usize {
        self.calls("api").iter().filter(|c| c[4] == "POST").count()
    }
    fn refs(&self) -> Value {
        let gl = self.request(json!({"op":"github","force":true}));
        assert_eq!(gl["ok"], true, "{gl}");
        assert_eq!(gl["data"]["github"]["error"], Value::Null, "{gl}");
        let t = &gl["data"]["github"]["threads"][0];
        json!([{"id":t["id"],"fingerprint":t["fingerprint"]}])
    }
    fn revision(&self) -> Value {
        let s = self.request(json!({"op":"snapshot"}));
        assert_eq!(s["ok"], true, "{s}");
        s["data"]["snapshot"]["revision"].clone()
    }
    fn prompt(&self) -> String {
        self.calls("send")[0]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[test]
fn merge_request_discussions_map_to_review_threads() {
    let f = Fixture::new();
    let gl = f.request(json!({"op":"github"}));
    let view = &gl["data"]["github"];
    assert_eq!(view["provider"], "gitlab", "{gl}");
    assert_eq!(view["pull_request"]["provider"], "gitlab");
    assert_eq!(view["pull_request"]["host"], "gitlab.com");
    assert_eq!(view["pull_request"]["number"], 1);
    assert_eq!(view["pull_request"]["base"], "main");
    let t = &view["threads"][0];
    assert_eq!(t["path"], "file.txt");
    assert_eq!(t["line"], 2);
    assert_eq!(t["side"], "RIGHT");
    assert_eq!(t["outdated"], false);
    assert_eq!(t["resolved"], false);
    assert_eq!(t["comments"][0]["author"], "reviewer");
    assert_eq!(
        t["comments"][0]["url"],
        "https://gitlab.com/group/repo/-/merge_requests/1#note_1"
    );
    for call in f.calls("api") {
        assert_eq!(call[2], "gitlab.com");
    }
}

#[test]
fn first_refresh_without_glab_is_still_labelled_gitlab() {
    let f = Fixture::new();
    fs::rename(&f.program, f.program.with_extension("disabled")).unwrap();
    let result = f.request(json!({"op":"github"}));
    assert_eq!(result["data"]["github"]["provider"], "gitlab", "{result}");
    assert!(
        result["data"]["github"]["error"]
            .as_str()
            .unwrap()
            .contains("glab")
    );
}

#[test]
fn missing_glab_preserves_cached_threads_and_does_not_break_local_reviews() {
    let f = Fixture::new();
    f.refs();
    fs::rename(&f.program, f.program.with_extension("disabled")).unwrap();
    let result = f.request(json!({"op":"github","force":true}));
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["data"]["github"]["threads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let error = result["data"]["github"]["error"].as_str().unwrap();
    assert!(error.contains("GitLab CLI (glab) was not found"), "{error}");
    assert!(error.contains("gitlab.com/gitlab-org/cli") && error.contains("glab auth login"));
    assert_eq!(result["data"]["github"]["provider"], "gitlab");
    assert_eq!(f.request(json!({"op":"snapshot"}))["ok"], true);
}

#[test]
fn glab_sign_in_failure_has_actionable_guidance() {
    let f = Fixture::new();
    f.update(|d| {
        d["fail"] = json!(true);
        d["fail_message"] = json!("glab: 401 Unauthorized");
    });
    let result = f.request(json!({"op":"github","force":true}));
    let error = result["data"]["github"]["error"].as_str().unwrap();
    assert!(error.starts_with("Sign in to GitLab"), "{error}");
    assert!(error.contains("--hostname gitlab.com"));
}

#[test]
fn explicit_reply_posts_once_and_never_sends_to_the_agent() {
    let f = Fixture::new();
    let refs = f.refs();
    let request = json!({"op":"github_reply","thread":refs[0],"body":"Fixed in the latest commit.","reply_id":"reply-test-1"});
    let result = f.request(request.clone());
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["data"]["reply"]["status"], "confirmed");
    assert_eq!(
        result["data"]["reply"]["url"],
        "https://gitlab.com/group/repo/-/merge_requests/1#note_99"
    );
    assert_eq!(
        result["data"]["github"]["threads"][0]["comments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let duplicate = f.request(request);
    assert_eq!(duplicate["data"]["reply"]["status"], "confirmed");
    assert_eq!(f.posts(), 1);
    assert!(f.calls("send").is_empty());
}

#[test]
fn stale_reply_is_refused_and_uncertain_reply_requires_explicit_retry() {
    let f = Fixture::new();
    let old = f.refs();
    f.update(|d| {
        d["discussions"][0]["notes"]
            .as_array_mut()
            .unwrap()
            .push(note(2, "A new concern"))
    });
    let stale =
        f.request(json!({"op":"github_reply","thread":old[0],"body":"Thanks","reply_id":"stale"}));
    assert_eq!(stale["ok"], false);
    assert!(stale["error"].as_str().unwrap().contains("Thread changed"));
    let refs = f.refs();
    f.update(|d| d["reply_fail"] = json!(true));
    let request =
        json!({"op":"github_reply","thread":refs[0],"body":"Thanks","reply_id":"uncertain"});
    assert_eq!(
        f.request(request.clone())["data"]["reply"]["status"],
        "uncertain"
    );
    assert_eq!(
        f.request(request.clone())["data"]["reply"]["status"],
        "uncertain"
    );
    let same_body =
        f.request(json!({"op":"github_reply","thread":refs[0],"body":"Thanks","reply_id":"other"}));
    assert_eq!(same_body["data"]["reply_id"], "uncertain");
    assert_eq!(f.posts(), 1);
    f.update(|d| d["reply_fail"] = json!(false));
    let mut retry = request;
    retry["retry"] = json!(true);
    assert_eq!(f.request(retry)["data"]["reply"]["status"], "confirmed");
}

#[test]
fn lost_reply_confirmation_is_not_automatically_reposted() {
    let f = Fixture::new();
    let refs = f.refs();
    f.update(|d| d["reply_lost"] = json!(true));
    let request = json!({"op":"github_reply","thread":refs[0],"body":"Already posted remotely","reply_id":"lost"});
    assert_eq!(
        f.request(request.clone())["data"]["reply"]["status"],
        "uncertain"
    );
    assert_eq!(f.request(request)["data"]["reply"]["status"], "uncertain");
    assert_eq!(f.posts(), 1);
}

#[test]
fn reads_are_cached_for_five_minutes_and_refresh_is_immediate() {
    let f = Fixture::new();
    f.request(json!({"op":"github"}));
    // MR lookup, MR details, one discussions page.
    assert_eq!(f.calls("api").len(), 3);
    f.request(json!({"op":"github"}));
    assert_eq!(f.calls("api").len(), 3);
    f.request(json!({"op":"github","force":true}));
    assert_eq!(f.calls("api").len(), 6);
    assert_eq!(f.calls("send").len(), 0);
}

#[test]
fn pagination_filters_general_individual_and_system_notes() {
    let f = Fixture::new();
    f.update(|d| {
        let mut all = vec![];
        for i in 0..120 {
            all.push(discussion(&format!("d{i}"), json!([note(i, "Diff note")])));
        }
        let mut general = note(500, "Please add a changelog entry");
        general["type"] = Value::Null;
        general["position"] = Value::Null;
        all.push(discussion("general1", json!([general.clone()])));
        let mut comment = general.clone();
        comment["resolvable"] = json!(false);
        let mut individual = discussion("individual1", json!([comment]));
        individual["individual_note"] = json!(true);
        all.push(individual);
        let mut system = note(501, "added 1 commit");
        system["system"] = json!(true);
        all.push(discussion("system1", json!([system])));
        d["discussions"] = json!(all);
    });
    let gl = f.request(json!({"op":"github"}));
    let threads = gl["data"]["github"]["threads"].as_array().unwrap();
    assert_eq!(threads.len(), 121, "{gl}");
    let general = threads.iter().find(|t| t["id"] == "general1").unwrap();
    assert_eq!(general["path"], "");
    assert_eq!(general["line"], Value::Null);
    let pages = f
        .calls("api")
        .iter()
        .filter(|c| c[5].as_str().unwrap().ends_with("/discussions"))
        .count();
    assert_eq!(pages, 2);
}

#[test]
fn fix_thread_sends_gitlab_context_and_general_discussions() {
    let f = Fixture::new();
    f.update(|d| {
        let mut general = note(7, "Explain the rollout plan");
        general["type"] = Value::Null;
        general["position"] = Value::Null;
        d["discussions"] = json!([discussion("general1", json!([general]))]);
    });
    let revision = f.revision();
    assert_eq!(f.request(json!({"op":"add","revision":revision,"path":"file.txt","selection":null,"body":"UNRELATED-LOCAL-NOTE"}))["ok"],true);
    let refs = f.refs();
    let sent = f.request(
        json!({"op":"send","revision":revision,"target":"t7","threads":refs,"include_local":false}),
    );
    assert_eq!(sent["ok"], true, "{sent}");
    assert_eq!(sent["data"]["github"]["threads"][0]["delivery"], "sent");
    let prompt = f.prompt();
    assert!(
        prompt.contains(
            "GitLab review feedback from https://gitlab.com/group/repo/-/merge_requests/1"
        )
    );
    assert!(prompt.contains("Do not post replies or resolve GitLab threads"));
    assert!(prompt.contains("General merge request discussion"));
    assert!(prompt.contains("Explain the rollout plan"));
    assert!(!prompt.contains("UNRELATED-LOCAL-NOTE"));
    let duplicate = f.request(
        json!({"op":"send","revision":revision,"target":"t7","threads":refs,"include_local":false}),
    );
    assert_eq!(duplicate["ok"], false);
    assert_eq!(f.calls("send").len(), 1);
}

#[test]
fn outdated_resolved_and_failed_refresh_threads_are_guarded() {
    let f = Fixture::new();
    f.update(|d| d["mr"]["diff_refs"]["head_sha"] = json!("sha2"));
    let gl = f.request(json!({"op":"github"}));
    assert_eq!(gl["data"]["github"]["threads"][0]["outdated"], true);
    let refs = f.refs();
    let revision = f.revision();
    f.update(|d| d["fail"] = json!(true));
    let gl = f.request(json!({"op":"github","force":true}));
    assert!(gl["data"]["github"]["error"].is_string());
    assert_eq!(gl["data"]["github"]["threads"].as_array().unwrap().len(), 1);
    assert_eq!(
        f.request(json!({"op":"send","revision":revision,"target":"t7","threads":refs}))["ok"],
        false
    );
    f.update(|d| {
        d["fail"] = json!(false);
        d["discussions"][0]["notes"][0]["resolved"] = json!(true);
    });
    let current = f.refs();
    let gl = f.request(json!({"op":"github"}));
    assert_eq!(gl["data"]["github"]["threads"][0]["resolved"], true);
    assert_eq!(
        f.request(json!({"op":"send","revision":revision,"target":"t7","threads":current}))["ok"],
        false
    );
    assert_eq!(f.calls("send").len(), 0);
}

#[test]
fn closed_or_missing_merge_requests_are_reported() {
    let f = Fixture::new();
    f.update(|d| d["mrs"] = json!([]));
    let gl = f.request(json!({"op":"github"}));
    assert_eq!(gl["data"]["github"]["pull_request"], Value::Null);
    assert_eq!(gl["data"]["github"]["provider"], "gitlab");
    f.update(|d| {
        d["mrs"] = json!([{"iid":1}]);
        d["mr"]["state"] = json!("merged");
    });
    let gl = f.request(json!({"op":"github","force":true}));
    assert!(
        gl["data"]["github"]["error"]
            .as_str()
            .unwrap()
            .contains("no longer open")
    );
    f.update(|d| d["mrs"] = json!([{"iid":1},{"iid":2}]));
    let gl = f.request(json!({"op":"github","force":true}));
    assert!(
        gl["data"]["github"]["error"]
            .as_str()
            .unwrap()
            .contains("Multiple open MRs")
    );
}

#[test]
fn self_hosted_hosts_require_an_explicit_allowlist() {
    let f = Fixture::new();
    f.update(|d| {
        d["host"] = json!("git.example.com");
        d["mr"]["web_url"] = json!("https://git.example.com/group/repo/-/merge_requests/1");
    });
    git(
        &f.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://git@git.example.com:2222/group/repo.git",
        ],
    );
    let gl = f.request(json!({"op":"github","force":true}));
    let error = gl["data"]["github"]["error"].as_str().unwrap();
    assert!(error.contains("HERDR_ANNOTATOR_GITLAB_HOSTS"), "{error}");
    assert!(f.calls("api").is_empty());
    let gl = f.request_with(json!({"op":"github","force":true}), "git.example.com");
    assert_eq!(gl["data"]["github"]["error"], Value::Null, "{gl}");
    assert_eq!(
        gl["data"]["github"]["pull_request"]["host"],
        "git.example.com"
    );
    assert!(f.calls("api").iter().all(|c| c[2] == "git.example.com"));
}

#[test]
fn installer_recorded_hosts_are_allowed() {
    let f = Fixture::new();
    f.update(|d| d["host"] = json!("git.example.com"));
    git(
        &f.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://git.example.com/group/repo.git",
        ],
    );
    let receipt = f.dir.path().join(".local/share/herdr-annotator");
    fs::create_dir_all(&receipt).unwrap();
    fs::write(
        receipt.join("install.json"),
        json!({"gitlab_hosts":["git.example.com"]}).to_string(),
    )
    .unwrap();
    let gl = f.request(json!({"op":"github","force":true}));
    assert_eq!(gl["data"]["github"]["error"], Value::Null, "{gl}");
}

#[test]
fn fork_merge_requests_must_come_from_the_origin_project() {
    let f = Fixture::new();
    git(
        &f.repo,
        &[
            "remote",
            "add",
            "upstream",
            "https://gitlab.com/group/repo.git",
        ],
    );
    git(
        &f.repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://gitlab.com/me/repo.git",
        ],
    );
    f.update(|d| {
        d["projects"] = json!({"me%2Frepo": 20});
        d["mr"]["source_project_id"] = json!(20);
    });
    let gl = f.request(json!({"op":"github","force":true}));
    assert_eq!(gl["data"]["github"]["error"], Value::Null, "{gl}");
    assert_eq!(
        gl["data"]["github"]["pull_request"]["base_remote"],
        "upstream"
    );
    assert_eq!(
        gl["data"]["github"]["pull_request"]["repository"],
        "group/repo"
    );
    f.update(|d| d["mr"]["source_project_id"] = json!(30));
    let gl = f.request(json!({"op":"github","force":true}));
    assert!(
        gl["data"]["github"]["error"]
            .as_str()
            .unwrap()
            .contains("does not match")
    );
}

#[test]
fn read_markers_are_local_and_new_notes_become_unread() {
    let f = Fixture::new();
    let refs = f.refs();
    let calls = f.calls("api").len();
    let marked = f.request(json!({"op":"github_read","thread":refs[0],"read":true}));
    assert_eq!(
        marked["data"]["github"]["threads"][0]["read"], true,
        "{marked}"
    );
    assert_eq!(f.calls("api").len(), calls);
    f.update(|d| {
        d["discussions"][0]["notes"]
            .as_array_mut()
            .unwrap()
            .push(note(2, "New reply"))
    });
    f.refs();
    assert_eq!(
        f.request(json!({"op":"github"}))["data"]["github"]["threads"][0]["read"],
        false
    );
}
