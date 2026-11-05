//! GitLab merge request discussions through `glab`, mirroring the GitHub/`gh` flow.
use crate::{
    Result,
    github::{GithubComment, GithubThread, PullRequest},
    model::hash,
};
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
