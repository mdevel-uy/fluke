use std::io;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Codex,
    Claude,
    Custom,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude",
            Self::Custom => "Personalizado",
        }
    }
    pub fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Custom => "",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentConfig {
    pub provider: Provider,
    pub executable: String,
    pub model: String,
    pub arguments: Vec<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Codex,
            executable: "codex".into(),
            model: String::new(),
            arguments: Vec::new(),
        }
    }
}

impl AgentConfig {
    pub fn validate(&self) -> io::Result<()> {
        if self.executable.trim().is_empty()
            || self.executable.chars().any(char::is_control)
            || self.model.chars().any(char::is_control)
            || self.arguments.iter().any(|arg| arg.contains('\0'))
        {
            return Err(io::Error::other(
                "Indicá un ejecutable y valores sin caracteres de control",
            ));
        }
        if self.provider == Provider::Custom
            && !self.model.is_empty()
            && !self.arguments.iter().any(|arg| arg == "{model}")
        {
            return Err(io::Error::other(
                "Para una CLI personalizada usá {model} como argumento del modelo",
            ));
        }
        if self.model.is_empty() && self.arguments.iter().any(|arg| arg == "{model}") {
            return Err(io::Error::other("El argumento {model} necesita un modelo"));
        }
        if self.provider != Provider::Custom
            && self.arguments.iter().any(|arg| {
                arg == "-m"
                    || arg == "--model"
                    || arg.starts_with("--model=")
                    || arg.starts_with("-m=")
                    || (arg.starts_with("-m") && arg.len() > 2)
            })
        {
            return Err(io::Error::other(
                "Elegí el modelo en su campo, sin duplicar --model en argumentos",
            ));
        }
        Ok(())
    }

    pub fn launch_arguments(&self) -> io::Result<Vec<String>> {
        self.validate()?;
        let mut args = self
            .arguments
            .iter()
            .map(|arg| {
                if arg == "{model}" {
                    self.model.clone()
                } else {
                    arg.clone()
                }
            })
            .collect::<Vec<_>>();
        if self.provider != Provider::Custom && !self.model.is_empty() {
            args.extend(["--model".into(), self.model.clone()]);
        }
        Ok(args)
    }
}

pub struct ConfigDraft {
    pub provider: Provider,
    pub fields: [String; 4],
    pub selected: usize,
    pub error: String,
}

impl ConfigDraft {
    pub fn new(config: Option<&AgentConfig>, limit: usize) -> Self {
        let config = config.cloned().unwrap_or_default();
        Self {
            provider: config.provider,
            fields: [
                config.executable,
                config.model,
                serde_json::to_string(&config.arguments).unwrap_or_else(|_| "[]".into()),
                limit.to_string(),
            ],
            selected: 0,
            error: String::new(),
        }
    }

    pub fn values(&self) -> io::Result<(AgentConfig, usize)> {
        let config = AgentConfig { provider: self.provider, executable: self.fields[0].trim().into(),
            model: self.fields[1].trim().into(), arguments: serde_json::from_str(&self.fields[2])
                .map_err(|_| io::Error::other("Argumentos debe ser una lista JSON de textos, por ejemplo [\"--no-alt-screen\"]"))? };
        config.validate()?;
        let limit = self.fields[3]
            .parse::<usize>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| io::Error::other("El máximo de workers debe ser mayor que cero"))?;
        Ok((config, limit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_is_a_separate_argument_not_shell_code() {
        let config = AgentConfig {
            model: "model with spaces; $x".into(),
            ..Default::default()
        };
        assert_eq!(
            config.launch_arguments().unwrap(),
            vec!["--model", "model with spaces; $x"]
        );
        let duplicate = AgentConfig {
            arguments: vec!["--model=other".into()],
            ..config
        };
        assert!(duplicate.launch_arguments().is_err());
    }
    #[test]
    fn custom_models_need_an_explicit_placeholder() {
        let mut config = AgentConfig {
            provider: Provider::Custom,
            model: "local".into(),
            ..Default::default()
        };
        assert!(config.validate().is_err());
        config.arguments = vec!["--chosen-model".into(), "{model}".into()];
        assert_eq!(
            config.launch_arguments().unwrap(),
            vec!["--chosen-model", "local"]
        );
    }
}
