use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    RouteRegistry { routes: Vec<String> },
    Ready,
    Render { route_id: u32, url: String },
    RenderOk { html: String },
    RenderErr { message: String },
    Shutdown,
}

pub async fn send_frame<W>(writer: &mut W, frame: &Frame) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let body = serde_json::to_vec(frame).map_err(io_err)?;
    if body.len() > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "frame too large",
        ));
    }
    let len = u32::try_from(body.len()).map_err(io_err)?;
    writer.write_all(&len.to_le_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn recv_frame<R>(reader: &mut R) -> std::io::Result<Frame>
where
    R: AsyncReadExt + Unpin,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map_err(io_err)
}

fn io_err<E: Into<Box<dyn std::error::Error + Send + Sync>>>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, e)
}
