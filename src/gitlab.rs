//! GitLab merge request discussions through `glab`, mirroring the GitHub/`gh` flow.
use crate::{
    Result,
    github::{GithubComment, GithubThread, PullRequest},
    model::hash,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::process::Command;

const PER_PAGE: usize = 100;
const MAX_PAGES: usize = 50;

/// gitlab.com, plus self-hosted instances the user explicitly allowed. Never route
/// glab credentials to an arbitrary hostname found in a repository's remote.
pub(crate) fn hosts() -> Vec<String> {
    let mut hosts = vec!["gitlab.com".to_owned()];
    let configured = std::env::var("HERDR_ANNOTATOR_GITLAB_HOSTS").unwrap_or_default();
    let configured = configured
        .split([',', ' ', '\n', '\t'])
        .map(str::to_owned)
        .chain(crate::executables::gitlab_hosts());
    for host in configured {
        let host = host.trim().to_ascii_lowercase();
        if valid_host(&host) && host != "github.com" && !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    hosts
}

fn valid_host(host: &str) -> bool {
    let (name, port) = host.split_once(':').unwrap_or((host, ""));
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        && (host.find(':').is_none()
            || (!port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit())))
}

/// Returns `(host, group/…/project)` for a supported GitLab remote URL.
pub(crate) fn repository(url: &str, hosts: &[String]) -> Option<(String, String)> {
    let (host, path) = if let Some(rest) = url.strip_prefix("ssh://git@") {
        let (host, path) = rest.split_once('/')?;
        // An SSH port is not part of the API hostname.
        let host = match host.split_once(':') {
            Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
                name
            }
            Some(_) => return None,
            None => host,
        };
        (host, path)
    } else if let Some(rest) = url.strip_prefix("git@") {
        rest.split_once(':')?
    } else {
        url.strip_prefix("https://")?.split_once('/')?
    };
    let host = host.to_ascii_lowercase();
    if !hosts.contains(&host) {
        return None;
    }
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 2
        || parts.len() > 20
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || *p == "-"
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return None;
    }
    Some((host, path.to_owned()))
}

fn project(path: &str) -> String {
    format!("projects/{}", path.replace('/', "%2F"))
}

fn glab(host: &str, args: &[String]) -> Result<Value> {
    let mut command = Command::new(crate::executables::tool("glab", "HERDR_ANNOTATOR_GLAB"));
    command
        .env("GLAB_NO_PROMPT", "1")
        .env("GLAB_PAGER", "cat")
        .env("GLAB_CHECK_UPDATE", "false")
        .env("GLAB_SEND_TELEMETRY", "false")
        .env("NO_COLOR", "1")
        .args(["api", "--hostname", host])
        .args(args);
    let out = crate::process::run(&mut command, crate::process::MAX_OUTPUT)
        .map_err(|e| if e.starts_with("Cannot start command (not found)") {
            "GitLab CLI (glab) was not found. Install it from https://gitlab.com/gitlab-org/cli, then run glab auth login on this computer and Refresh. Local reviews still work.".into()
        } else { format!("GitLab request failed: {e}") })?;
    if out.code != 0 {
        if out.stderr.contains("glab auth login")
            || out.stderr.contains("GITLAB_TOKEN")
            || out.stderr.contains("401")
            || out.stderr.contains("not authenticated")
        {
            return Err(format!(
                "Sign in to GitLab: run glab auth login --hostname {host} on this computer, then Refresh. Local reviews still work."
            ));
        }
        return Err(format!(
            "{}. Check glab auth status and project access.",
            out.failure("GitLab request")
        ));
    }
    if out.truncated {
        return Err("GitLab request exceeded its size limit".into());
    }
    serde_json::from_str(&out.text).map_err(|_| "GitLab returned invalid JSON".into())
}

fn get(host: &str, endpoint: String, query: &[(&str, String)]) -> Result<Value> {
    let mut args = vec!["--method".into(), "GET".into(), endpoint];
    for (key, value) in query {
        args.extend(["-f".into(), format!("{key}={value}")]);
    }
    glab(host, &args)
}

fn line(value: &Value, side: &str) -> Option<u64> {
    value[if side == "LEFT" {
        "old_line"
    } else {
        "new_line"
    }]
    .as_u64()
}

fn thread(raw: &Value, mr: &Value) -> Result<Option<GithubThread>> {
    let notes: Vec<&Value> = raw["notes"]
        .as_array()
        .ok_or("Incomplete GitLab response")?
        .iter()
        .filter(|n| n["system"] != true)
        .collect();
    let Some(first) = notes.first() else {
        return Ok(None);
    };
    let diff = first["type"] == "DiffNote";
    if !diff && (raw["individual_note"] == true || first["resolvable"] != true) {
        return Ok(None);
    }
    let id = raw["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
        .ok_or("Missing or invalid discussion id")?
        .to_owned();
    let position = &first["position"];
    let (path, side, line_end, line_start, outdated) = if diff {
        let side = if position["new_line"].is_u64() {
            "RIGHT"
        } else {
            "LEFT"
        };
        let path = if side == "LEFT" {
            position["old_path"].as_str()
        } else {
            position["new_path"].as_str()
        }
        .or_else(|| position["new_path"].as_str())
        .ok_or("Missing discussion path")?;
        let range = &position["line_range"];
        let end = line(&range["end"], side).or_else(|| line(position, side));
        let start = line(&range["start"], side).filter(|s| Some(*s) != end);
        let outdated = position["head_sha"] != mr["diff_refs"]["head_sha"];
        (path.to_owned(), side, end, start, outdated)
    } else {
        (String::new(), "", None, None, false)
    };
    let resolvable: Vec<_> = notes.iter().filter(|n| n["resolvable"] == true).collect();
    let resolved = !resolvable.is_empty() && resolvable.iter().all(|n| n["resolved"] == true);
    let incomplete = notes.len() > 500
        || notes
            .iter()
            .any(|n| n["body"].as_str().is_none_or(|s| s.len() > 16_384));
    let web_url = mr["web_url"].as_str().unwrap_or("");
    Ok(Some(GithubThread {
        fingerprint: hash(json!([raw, outdated]).to_string().as_bytes()),
        id,
        path,
        line: line_end,
        start_line: line_start,
        side: side.into(),
        resolved,
        outdated,
        incomplete,
        snippet: String::new(), // GitLab discussions carry no diff hunk.
        comments: notes
            .iter()
            .take(500)
            .map(|n| GithubComment {
                author: n["author"]["username"].as_str().unwrap_or("ghost").into(),
                body: n["body"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(16_384)
                    .collect(),
                url: n["id"]
                    .as_u64()
                    .map(|id| format!("{web_url}#note_{id}"))
                    .unwrap_or_default(),
                updated_at: n["updated_at"].as_str().unwrap_or("").into(),
            })
            .collect(),
    }))
}

pub(crate) fn fetch(
    host: &str,
    base_repo: &str,
    head_repo: &str,
    branch: &str,
    base_remote: &str,
) -> Result<(Option<PullRequest>, Vec<GithubThread>, bool)> {
    let base = project(base_repo);
    let mrs = get(
        host,
        format!("{base}/merge_requests"),
        &[
            ("state", "opened".into()),
            ("source_branch", branch.into()),
            ("per_page", "2".into()),
        ],
    )?;
    let mrs = mrs
        .as_array()
        .ok_or("Invalid GitLab merge request response")?;
    if mrs.is_empty() {
        return Ok((None, vec![], false));
    }
    if mrs.len() != 1 {
        return Err(
            "Multiple open MRs match this branch; refusing to guess a review target".into(),
        );
    }
    let iid = mrs[0]["iid"].as_u64().ok_or("Missing MR number")?;
    let mr = get(host, format!("{base}/merge_requests/{iid}"), &[])?;
    if mr["state"] != "opened" {
        return Err("Merge request is no longer open; refresh".into());
    }
    let source = mr["source_project_id"]
        .as_u64()
        .ok_or("Missing MR source project")?;
    let head = if head_repo.eq_ignore_ascii_case(base_repo) {
        mr["target_project_id"].as_u64()
    } else {
        get(host, project(head_repo), &[])?["id"].as_u64()
    };
    if mr["source_branch"] != branch || head != Some(source) {
        return Err("GitLab MR source does not match this checkout's branch/project".into());
    }
    let pr = PullRequest {
        number: iid,
        url: mr["web_url"].as_str().ok_or("Missing MR URL")?.into(),
        base: mr["target_branch"]
            .as_str()
            .ok_or("Missing MR base")?
            .into(),
        base_remote: base_remote.into(),
        repository: base_repo.into(),
        head: branch.into(),
        provider: "gitlab".into(),
        host: host.into(),
    };
    let mut threads = vec![];
    let mut limited = false;
    for page in 1..=MAX_PAGES {
        let result = get(
            host,
            format!("{base}/merge_requests/{iid}/discussions"),
            &[
                ("per_page", PER_PAGE.to_string()),
                ("page", page.to_string()),
            ],
        )?;
        let discussions = result
            .as_array()
            .ok_or("Invalid GitLab discussions response")?;
        for raw in discussions {
            if let Some(thread) = thread(raw, &mr)? {
                if threads.len() >= 200 {
                    limited = true;
                    break;
                }
                threads.push(thread);
            }
        }
        if limited || discussions.len() < PER_PAGE {
            break;
        }
        if page == MAX_PAGES {
            limited = true;
        }
    }
    Ok((Some(pr), threads, limited))
}

/// Read-only merge request context shown above the review threads: who approved,
/// who is still missing, and the latest pipeline with its stages and jobs.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MrOverview {
    pub approvals: Option<Approvals>,
    pub pipeline: Option<Pipeline>,
    /// Sections GitLab would not return (permissions, tier); never fatal.
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Approvals {
    pub approved: bool,
    pub required: u64,
    pub left: u64,
    pub approved_by: Vec<String>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pipeline {
    pub id: u64,
    pub status: String,
    pub url: String,
    pub stages: Vec<Stage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stage {
    pub name: String,
    pub status: String,
    pub jobs: Vec<Job>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub name: String,
    pub status: String,
    pub url: String,
    pub allow_failure: bool,
}

const MAX_NAMES: usize = 20;
const MAX_JOBS: usize = 500;
const JOB_PAGES: usize = 5;

fn text(value: &Value, limit: usize) -> String {
    value.as_str().unwrap_or("").chars().take(limit).collect()
}

fn usernames(users: &Value) -> Vec<String> {
    users
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u["username"].as_str())
        .map(|u| u.chars().take(100).collect())
        .collect()
}

fn approvals(host: &str, base: &str, iid: u64) -> Result<Approvals> {
    let a = get(host, format!("{base}/merge_requests/{iid}/approvals"), &[])?;
    let approved_by: Vec<String> = a["approved_by"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x["user"]["username"].as_str())
        .map(|u| u.chars().take(100).collect())
        .collect();
    let required = a["approvals_required"].as_u64().unwrap_or(0);
    let left = a["approvals_left"].as_u64().unwrap_or(0);
    let mut missing: Vec<String> = vec![];
    // Rules name the eligible approvers; without them (free tier) only counts are known.
    if let Ok(state) = get(
        host,
        format!("{base}/merge_requests/{iid}/approval_state"),
        &[],
    ) {
        for rule in state["rules"].as_array().into_iter().flatten() {
            if rule["approved"].as_bool().unwrap_or(true)
                || rule["approvals_required"].as_u64().unwrap_or(0) == 0
            {
                continue;
            }
            for user in usernames(&rule["eligible_approvers"]) {
                if !approved_by.contains(&user) && !missing.contains(&user) {
                    missing.push(user);
                }
            }
        }
    }
    missing.truncate(MAX_NAMES);
    Ok(Approvals {
        approved: a["approved"].as_bool().unwrap_or(left == 0),
        required,
        left,
        approved_by: approved_by.into_iter().take(MAX_NAMES).collect(),
        missing,
    })
}

fn stage_status(jobs: &[Job]) -> &'static str {
    let any = |f: &dyn Fn(&Job) -> bool| jobs.iter().any(f);
    if any(&|j| j.status == "failed" && !j.allow_failure) {
        "failed"
    } else if any(&|j| j.status == "running") {
        "running"
    } else if any(&|j| {
        [
            "created",
            "pending",
            "waiting_for_resource",
            "preparing",
            "scheduled",
        ]
        .contains(&j.status.as_str())
    }) {
        "pending"
    } else if any(&|j| j.status == "manual") {
        "manual"
    } else if any(&|j| j.status == "canceled") {
        "canceled"
    } else if jobs.iter().all(|j| j.status == "skipped") {
        "skipped"
    } else {
        "success"
    }
}

fn pipeline(host: &str, base: &str, iid: u64) -> Result<Option<Pipeline>> {
    let list = get(
        host,
        format!("{base}/merge_requests/{iid}/pipelines"),
        &[("per_page", "1".into())],
    )?;
    let Some(raw) = list.as_array().and_then(|a| a.first()) else {
        return Ok(None);
    };
    let id = raw["id"].as_u64().ok_or("Missing pipeline id")?;
    let project_id = raw["project_id"]
        .as_u64()
        .ok_or("Missing pipeline project")?;
    let mut jobs: Vec<(u64, String, Job)> = vec![];
    for page in 1..=JOB_PAGES {
        let result = get(
            host,
            format!("projects/{project_id}/pipelines/{id}/jobs"),
            &[
                ("per_page", PER_PAGE.to_string()),
                ("page", page.to_string()),
            ],
        )?;
        let batch = result.as_array().ok_or("Invalid GitLab jobs response")?;
        for job in batch {
            jobs.push((
                job["id"].as_u64().unwrap_or(0),
                text(&job["stage"], 100),
                Job {
                    name: text(&job["name"], 200),
                    status: text(&job["status"], 40),
                    url: text(&job["web_url"], 500),
                    allow_failure: job["allow_failure"].as_bool().unwrap_or(false),
                },
            ));
        }
        if batch.len() < PER_PAGE || jobs.len() >= MAX_JOBS {
            break;
        }
    }
    jobs.truncate(MAX_JOBS);
    // The API lists newest first; stages run in the order their first job was created.
    jobs.sort_by_key(|(id, ..)| *id);
    let mut stages: Vec<Stage> = vec![];
    for (_, stage, job) in jobs {
        match stages.iter_mut().find(|s| s.name == stage) {
            Some(existing) => existing.jobs.push(job),
            None => stages.push(Stage {
                name: stage,
                status: String::new(),
                jobs: vec![job],
            }),
        }
    }
    for stage in &mut stages {
        stage.status = stage_status(&stage.jobs).into();
    }
    Ok(Some(Pipeline {
        id,
        status: text(&raw["status"], 40),
        url: text(&raw["web_url"], 500),
        stages,
    }))
}

/// Never fails the refresh: a section GitLab refuses is reported in `errors`.
pub(crate) fn overview(pr: &PullRequest) -> MrOverview {
    let base = project(&pr.repository);
    let mut out = MrOverview::default();
    match approvals(&pr.host, &base, pr.number) {
        Ok(a) => out.approvals = Some(a),
        Err(e) => out.errors.push(format!("Approvals unavailable: {e}")),
    }
    match pipeline(&pr.host, &base, pr.number) {
        Ok(p) => out.pipeline = p,
        Err(e) => out.errors.push(format!("Pipeline unavailable: {e}")),
    }
    out
}

/// `Ok(Some(url))` confirms the note; `Ok(None)` means no confirmation was returned.
pub(crate) fn post_reply(
    pr: &PullRequest,
    discussion: &str,
    body: &str,
) -> Result<Option<Option<String>>> {
    if discussion.is_empty() || !discussion.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("Invalid discussion id".into());
    }
    let note = glab(
        &pr.host,
        &[
            "--method".into(),
            "POST".into(),
            format!(
                "{}/merge_requests/{}/discussions/{discussion}/notes",
                project(&pr.repository),
                pr.number
            ),
            "-f".into(),
            format!("body={body}"),
        ],
    )?;
    Ok(note["id"]
        .as_u64()
        .map(|id| Some(format!("{}#note_{id}", pr.url))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_parsing_only_accepts_allowed_hosts() {
        let hosts = vec!["gitlab.com".to_owned(), "git.example.com".to_owned()];
        for (url, path) in [
            ("git@gitlab.com:group/repo.git", "group/repo"),
            ("https://gitlab.com/group/sub/repo.git", "group/sub/repo"),
            ("ssh://git@gitlab.com/group/repo", "group/repo"),
            ("ssh://git@git.example.com:2222/a/b/c.git", "a/b/c"),
            ("https://git.example.com/a/b/", "a/b"),
        ] {
            assert_eq!(
                repository(url, &hosts).map(|(_, p)| p).as_deref(),
                Some(path),
                "{url}"
            );
        }
        for url in [
            "https://gitlab.com.evil.com/a/b",
            "https://evil.com/a/b",
            "https://token@gitlab.com/a/b",
            "https://oauth2:token@gitlab.com/a/b",
            "git@gitlab.com:../repo",
            "git@gitlab.com:repo",
            "https://gitlab.com/a/b/../c",
            "https://other.example.com/a/b",
            "ssh://git@gitlab.com:x/a/b",
            "https://github.com/a/b",
        ] {
            assert!(repository(url, &hosts).is_none(), "{url}");
        }
    }

    #[test]
    fn host_allowlist_rejects_invalid_names() {
        for host in ["gitlab.example.com", "git.local:8443", "a-b.c"] {
            assert!(valid_host(host), "{host}");
        }
        for host in [
            "",
            "a/b",
            "user@host",
            "-a.com",
            "a..com",
            "host:",
            "host:abc",
        ] {
            assert!(!valid_host(host), "{host}");
        }
    }
}
